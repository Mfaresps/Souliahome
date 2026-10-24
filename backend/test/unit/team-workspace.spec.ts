import { EmployeeScoringService } from '../../src/employee-performance/employee-scoring.service';
import { EmployeePerformanceController } from '../../src/employee-performance/employee-performance.controller';
import { ROLES_KEY } from '../../src/core/decorators/roles.decorator';
import { RolesGuard } from '../../src/core/guards/roles.guard';
import { Reflector } from '@nestjs/core';

const employee='507f1f77bcf86cd799439011';
function fixture() {
  const service:any=Object.create(EmployeeScoringService.prototype);
  service.resolvePeriod=()=>({period:'month'});service.periodMatch=()=>({createdAt:{$gte:new Date('2026-10-01')}});service.periodLabel=()=> 'October 2026';
  const users=[{_id:employee,name:'Sara',username:'sara',isActive:true},{_id:'other',name:'Other',isActive:false}];
  service.userModel={find:jest.fn((query:any)=>({select:()=>({lean:()=>({exec:async()=>query.isActive?.$ne===false?users.filter(user=>user.isActive!==false):users})})})),findOne:jest.fn(()=>({select:()=>({lean:()=>({exec:async()=>users[0]})})}))};
  service.shopifyOrderModel={aggregate:jest.fn(async()=>[{_id:employee,orders:250,pending:20},{_id:'other',orders:10,pending:0}])};
  service.followUpModel={aggregate:jest.fn(async()=>[{_id:employee,followUps:70,deferred:10,issues:15}])};
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
  expect(service.getMyWorkspace).toHaveBeenCalledWith(employee,'month');
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
