import { EmployeeScoringService } from '../../src/employee-performance/employee-scoring.service';
import { EmployeePerformanceController } from '../../src/employee-performance/employee-performance.controller';
import { ROLES_KEY } from '../../src/core/decorators/roles.decorator';
import { RolesGuard } from '../../src/core/guards/roles.guard';
import { Reflector } from '@nestjs/core';
import { isOpenShippingIssue } from '../../src/employee-performance/shipping-issue-state';
import * as fs from 'fs';
import * as path from 'path';

const employee='507f1f77bcf86cd799439011';
function fixture() {
  const service:any=Object.create(EmployeeScoringService.prototype);
  service.resolvePeriod=jest.fn(()=>({period:'month',key:'2026-10',start:new Date('2026-10-01'),end:new Date('2026-11-01')}));service.periodMatch=()=>({createdAt:{$gte:new Date('2026-10-01')}});service.periodLabel=()=> 'October 2026';
  const users=[{_id:employee,name:'Sara',username:'sara',isActive:true},{_id:'other',name:'Other',isActive:false}];
  service.userModel={find:jest.fn((query:any)=>({select:()=>({lean:()=>({exec:async()=>query.isActive?.$ne===false?users.filter(user=>user.isActive!==false):users})})})),findOne:jest.fn(()=>({select:()=>({lean:()=>({exec:async()=>users[0]})})}))};
  service.shopifyOrderModel={aggregate:jest.fn(async()=>[{_id:employee,orders:250,pending:20},{_id:'other',orders:10,pending:0}])};
  service.txModel={collection:{name:'transactions'}};
  service.followUpModel={aggregate:jest.fn(async(pipeline:any[])=>pipeline.some(stage=>stage.$lookup)
    ? Array.from({length:15},(_,i)=>({_id:`ticket-${i}`,responsibleId:employee,issueTransaction:{_id:`tx-${i}`,type:'مبيعات',bostaStatus:'RETURNED',shipIssueState:'open'}}))
    : [{_id:employee,followUps:70,deferred:10,issues:15}])};
  service.logModel={aggregate:jest.fn(async()=>[{_id:employee,points:88,delivered:12}])};
  return {service};
}
it('returns exact grouped workload counts independent of the bounded task lists',async()=>{
  const {service}=fixture();const result=await service.getTeamWorkspace();
  expect(result.employees[0]).toMatchObject({id:employee,orders:250,pending:20,followUps:70,deferred:10,actionable:60,issues:15,points:88,delivered:12});
  expect(result.employees).toHaveLength(1);
  expect(result.totals).toEqual({orders:250,pending:20,followUps:70,issues:15,deferred:10});
  expect(service.userModel.find).toHaveBeenCalledWith(expect.objectContaining({isActive:{$ne:false}}));
  expect(service.shopifyOrderModel.aggregate).toHaveBeenCalledTimes(1);
  expect(service.followUpModel.aggregate.mock.calls[0][0][0].$match).toMatchObject({cancelled:{$ne:true},status:{$nin:expect.arrayContaining(['تم حل المشكلة'])}});
});
it('loads the selected employee by id and omits their point message history',async()=>{
  const {service}=fixture();service.getMyWorkspace=jest.fn(async()=>({orders:[{ref:'123'}],followUps:[],adjustments:[{reason:'private message'}],adjustmentsTruncated:false,points:{total:88}}));
  const result=await service.getTeamEmployeeWorkspace(employee);
  expect(service.getMyWorkspace).toHaveBeenCalledWith(employee,undefined,undefined,true);
  expect(service.userModel.findOne).toHaveBeenCalledWith(expect.objectContaining({isActive:{$ne:false}}));
  expect(result.employee.id).toBe(employee);expect(result.orders).toEqual([{ref:'123'}]);
  expect(result.adjustments).toBeUndefined();expect(result.adjustmentsTruncated).toBeUndefined();
  await expect(service.getTeamEmployeeWorkspace('invalid')).rejects.toThrow('غير موجود');
  service.userModel.findOne.mockReturnValue({select:()=>({lean:()=>({exec:async()=>null})})});
  await expect(service.getTeamEmployeeWorkspace(employee)).rejects.toThrow('غير موجود');
});
it.each(['getTeamWorkspace','getTeamEmployeeWorkspace'])('guards %s against staff access',method=>{
  const handler=(EmployeePerformanceController.prototype as any)[method];
  expect(Reflect.getMetadata(ROLES_KEY,handler)).toEqual(['admin']);
  const guard=new RolesGuard(new Reflector());
  const context=(role:string)=>({getHandler:()=>handler,getClass:()=>EmployeePerformanceController,switchToHttp:()=>({getRequest:()=>({user:{role}})})} as any);
  expect(guard.canActivate(context('staff'))).toBe(false);expect(guard.canActivate(context('admin'))).toBe(true);
});

it('applies the selected period to every team aggregate and employee detail', async()=>{
  const {service}=fixture();
  await service.getTeamWorkspace('month','2026-10');
  expect(service.resolvePeriod).toHaveBeenCalledWith('month',expect.any(Date),'2026-10');
  expect(service.shopifyOrderModel.aggregate.mock.calls[0][0][0].$match.assignedAt).toEqual({$gte:'2026-10-01T00:00:00.000Z',$lt:'2026-11-01T00:00:00.000Z'});
  for(const model of [service.followUpModel,service.logModel]) expect(model.aggregate.mock.calls[0][0][0].$match.createdAt).toEqual({$gte:new Date('2026-10-01')});
  service.getMyWorkspace=jest.fn(async()=>({orders:[],followUps:[]}));
  await service.getTeamEmployeeWorkspace(employee,'month','2026-10');
  expect(service.getMyWorkspace).toHaveBeenCalledWith(employee,'month','2026-10',true);
});

it('counts unique orders with a current shipping issue, excluding stale follow-up tickets', async()=>{
  const {service}=fixture();
  const tx={_id:'2636',type:'مبيعات',bostaStatus:'RETURNED',shipIssueState:'open'};
  const tickets=[
    {_id:'open',responsibleId:employee,issueTransaction:tx},
    {_id:'duplicate',responsibleId:employee,issueTransaction:tx},
    ...['closed','reshipped'].map(state=>({_id:state,responsibleId:employee,issueTransaction:{...tx,_id:state,shipIssueState:state}})),
    {_id:'delivered',responsibleId:employee,issueTransaction:{...tx,_id:'delivered',bostaStatus:'DELIVERED'}},
  ];
  service.followUpModel.aggregate.mockImplementation(async(pipeline:any[])=>pipeline.some(stage=>stage.$lookup)?tickets:[{_id:employee,followUps:5,deferred:0,issues:5}]);
  const team=await service.getTeamWorkspace();
  expect(team.totals.issues).toBe(1);
  expect(team.employees[0].issues).toBe(1);
  service.getMyWorkspace=jest.fn(async()=>({followUps:tickets.map(ticket=>({id:ticket._id})),orders:[]}));
  const detail=await service.getTeamEmployeeWorkspace(employee);
  expect(detail.deliveryIssueFollowUpsCount).toBe(1);
  expect(detail.followUps.map((ticket:any)=>[ticket.id,ticket.isDeliveryIssue])).toEqual([
    ['open',true],['duplicate',true],['closed',false],['reshipped',false],['delivered',false],
  ]);
});

it('matches the shipping dashboard classification across shipment and resolution states',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
  function extract(name:string) {
    const start=source.indexOf(`function ${name}(`),open=source.indexOf('{',start);
    let depth=0;
    for(let i=open;i<source.length;i++) {
      if(source[i]==='{')depth++;
      if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
    }
    throw new Error(`Missing function ${name}`);
  }
  const dashboard=new Function('tx',`const t=k=>k;const ISSUE_SHIP_KEYS=['RETURNED','FAILED_ATTEMPT','DELIVERY_FAILED'];${extract('_dashShipStatus')};${extract('_dashShipIssueSettled')};${extract('_dashIsOpenIssue')};const status=_dashShipStatus(tx);return !!(!tx.cancelled&&tx.type==='مبيعات'&&status&&_dashIsOpenIssue(tx,status));`);
  for(const bostaStatus of ['', 'CREATED','DELIVERED','RETURNED','FAILED_ATTEMPT','DELIVERY_FAILED','UNKNOWN'])
    for(const shipIssueState of ['', 'open','awaiting','closed','reshipped'])
      for(const deliveredAt of ['', '2026-10-24'])
        for(const pickupStatus of ['', 'Ready','Delivered']) {
          const tx={type:'مبيعات',bostaStatus,shipIssueState,deliveredAt,pickupStatus};
          expect(isOpenShippingIssue(tx)).toBe(dashboard(tx));
        }
});
