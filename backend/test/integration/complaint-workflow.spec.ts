import { Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { ComplaintSchema } from '../../src/complaints/schemas/complaint.schema';
import { ComplaintsService } from '../../src/complaints/complaints.service';
import { linkComplaintCase } from '../../src/complaints/complaint-workflow';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { ComplaintsController } from '../../src/complaints/complaints.controller';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import sharp from 'sharp';

describe('Complaint lifecycle with isolated transactional storage', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, Model: any, service: ComplaintsService, actor: any, sale: any;
  let app: any, base: string;
  const oid = () => new Types.ObjectId();
  beforeAll(async () => {
    mongo = await trackingMongo(); Model = mongo.connection.model('Complaint', ComplaintSchema);
    await Model.createCollection(); await Model.syncIndexes();
    for (const name of ['users','transactions','returnrequests','vaultentries','expenses']) await mongo.connection.createCollection(name);
    const vault: any = { addSystemEntry: async (amount: number, method: string, desc: string, date: string, source: string, ref: string, entity: any, by: string, meta: any, context: any) => {
      const doc = { _id: oid(), amount, method, ref, ...meta };
      await mongo.connection.collection('vaultentries').insertOne(doc, { session: context.session }); return doc;
    } };
    service = new ComplaintsService(Model, vault);
    const module = await Test.createTestingModule({controllers:[ComplaintsController],providers:[{provide:ComplaintsService,useValue:service}]}).overrideGuard(JwtAuthGuard).useValue({canActivate(context:any){const req=context.switchToHttp().getRequest();req.user={...actor,role:req.headers['x-test-role']||'admin',perms:[]};return true;}}).compile();
    app=module.createNestApplication({logger:false});app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.listen(0,'127.0.0.1');base=await app.getUrl();
  }, 40000);
  afterAll(async () => {await app?.close();await mongo?.close();});
  beforeEach(async () => {
    for (const name of ['complaints','users','transactions','returnrequests','vaultentries','expenses','complaintmessageconfigs']) await mongo.connection.collection(name).deleteMany({});
    actor = { userId: String(oid()), role: 'admin', name: 'Owner' };
    await mongo.connection.collection('users').insertOne({ _id: new Types.ObjectId(actor.userId), name: 'Owner', role: 'admin' });
    sale = { _id: oid(), ref: '2790', client: 'Customer', phone: '01000000000', type: 'مبيعات', total:500,remaining:0,deliveredAt: new Date().toISOString(), items: [{ lineId:'line-a', code:'A', name:'Product A', qty:3 }, { lineId:'line-b', code:'B', name:'Product B', qty:2 }] };
    await mongo.connection.collection('transactions').insertOne(sale);
  });
  const dueAt = () => new Date(Date.now()+86400000).toISOString();
  const createBody = () => ({ operationKey:String(oid()), transactionId:String(sale._id), description:'Two affected products', items:[{lineIndex:0,qty:1},{lineIndex:1,qty:1}] });
  const create = (body: any = createBody()) => service.create(body, 'Owner', actor.userId);
  const step = (row: any, action: string, extra: any = {}) => service.workflow(String(row._id), { operationKey:String(oid()),expectedRevision:row.workflow?.revision||0, action, note:'Documented action', dueAt:dueAt(), ...extra }, actor);
  async function execution(row: any, kind = 'exchange', workflow: any = {}) {
    const linked: any = { _id:oid(),originalTransactionId:String(sale._id),requestKind:kind,items:row.items,
      workflow:{version:2,ref:'AS-2026-000002',stage:'approved',quote:{refundDue:0,collectDue:0},selectedLines:row.items,...workflow} };
    await mongo.connection.collection('returnrequests').insertOne(linked);
    return linked;
  }
  it('creates one multi-item complaint, preserves affected quantities, and deduplicates concurrent retries', async () => {
    const body=createBody();const [a,b]=await Promise.all([create(body),create(body)]);
    expect(String(a._id)).toBe(String(b._id));expect(await Model.countDocuments()).toBe(1);expect(a.items.map((i:any)=>i.qty)).toEqual([1,1]);
    await expect(create({...body,description:'changed'})).rejects.toThrow();
    expect(a.surveyToken).toBeUndefined();
  });
  it('requires contact information without an invoice and validates line quantities', async () => {
    await expect(create({description:'No contact'})).rejects.toThrow();
    await expect(create({...createBody(),items:[{lineIndex:0,qty:5}]})).rejects.toThrow();
    await expect(create({...createBody(),items:[{lineIndex:0,qty:1,unitIds:[String(oid()),String(oid())]}]})).rejects.toThrow();
    const row=await create({description:'General service issue',clientName:'Test',phone:'01000000000'});expect(row.workflow.ownerId).toBe(actor.userId);
    await mongo.connection.collection('transactions').updateOne({_id:sale._id},{$unset:{phone:''}});
    const linked=await step(row,'items',{transactionId:String(sale._id),items:[{lineIndex:0,qty:1}]});
    expect(linked.phone).toBe('01000000000');
  });
  it('refuses manual success and legacy decision bypasses', async () => {
    const row=await create();await expect(step(row,'close',{outcome:'resolved',customerConfirmed:true})).rejects.toThrow();
    await expect(service.updateProgressStage(String(row._id),'تم حل المشكلة بنجاح','Owner')).rejects.toThrow();
    await expect(service.resolve(String(row._id),{status:'مقبول',managerAction:'استبدال'},'Owner')).rejects.toThrow();
  });
  it('links the correct case, prevents premature closure, and separates customer resolution from carrier settlement', async () => {
    let row:any=await create();row=await step(row,'plan',{solution:'exchange'});const linked=await execution(row);
    row=await step(row,'link',{caseId:String(linked._id)});expect(row.lifecycleStage).toBe('execution');
    await expect(step(row,'close',{outcome:'resolved',customerConfirmed:true})).rejects.toThrow();
    await mongo.connection.collection('returnrequests').updateOne({_id:linked._id},{$set:{'workflow.receivedAt':new Date().toISOString(),'workflow.replacementDeliveredAt':new Date().toISOString()}});
    row=await service.detail(String(row._id));expect(row.lifecycleStage).toBe('confirmation');
    row=await step(row,'close',{outcome:'resolved',customerConfirmed:true,customerMessage:'Your replacement was delivered'});
    expect(row.workflow.stage).toBe('closed');expect(row.workflow.financialPending).toBe(true);expect(row.inFollowUp).toBe(false);expect(row.surveySlug).toBeTruthy();
    const survey=await service.publicSurvey(row.surveySlug);expect(survey).not.toHaveProperty('phone');expect(survey).not.toHaveProperty('notes');expect(survey).not.toHaveProperty('workflow');expect(survey.actionNote).toBe('Your replacement was delivered');
    await service.submitSurvey(row.surveySlug,{rating:1,comment:'Still unhappy'});row=await service.detail(String(row._id));expect(row.workflow.reviewRequired).toBe(true);
    const token=row.surveySlug;row=await step(row,'reopen');expect(row.workflow.cycle).toBe(2);expect(row.workflow.cycles[0].caseId).toBe(String(linked._id));
    await expect(service.publicSurvey(token)).rejects.toThrow();
  });
  it('enforces return refund evidence and rejects mismatched invoice/item links', async () => {
    let row:any=await create();row=await step(row,'plan',{solution:'return'});const linked=await execution(row,'return',{receivedAt:new Date().toISOString(),quote:{refundDue:500,collectDue:0}});
    linked.originalTransactionId=String(oid());await mongo.connection.collection('returnrequests').updateOne({_id:linked._id},{$set:{originalTransactionId:linked.originalTransactionId}});
    await expect(step(row,'link',{caseId:String(linked._id)})).rejects.toThrow();
    await mongo.connection.collection('returnrequests').updateOne({_id:linked._id},{$set:{originalTransactionId:String(sale._id)}});
    row=await step(row,'link',{caseId:String(linked._id)});expect(row.execution.blockers).toContain('refund');
    await expect(step(row,'close',{outcome:'unreachable'})).rejects.toThrow();
    await mongo.connection.collection('returnrequests').updateOne({_id:linked._id},{$set:{'workflow.refund':{amount:500,at:new Date().toISOString()}}});
    row=await step(row,'close',{outcome:'resolved',customerConfirmed:true});expect(row.workflow.stage).toBe('closed');
  });
  it('records compensation once and rejects stale or unauthorized actions', async () => {
    let row:any=await create();row=await step(row,'plan',{solution:'compensation',amount:100,confirmed:true});
    const body:any={operationKey:String(oid()),expectedRevision:row.workflow.revision,action:'payment',note:'Paid',method:'كاش',reference:'PAY-1',confirmed:true};
    await service.workflow(String(row._id),body,actor);await service.workflow(String(row._id),body,actor);
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(1);
    expect(await mongo.connection.collection('expenses').countDocuments()).toBe(1);
    await expect(step(row,'wait',{waitingFor:'customer'})).rejects.toThrow();
    row=await service.detail(String(row._id));await expect(service.workflow(String(row._id),{...body,operationKey:String(oid()),expectedRevision:row.workflow.revision,action:'close',outcome:'resolved',customerConfirmed:true},{...actor,role:'staff'})).rejects.toThrow();
  });
  it('links newly-created execution and complaint atomically; rollback leaves neither half committed', async () => {
    let row:any=await create();row=await step(row,'plan',{solution:'exchange'});
    const linked:any={_id:oid(),originalTransactionId:String(sale._id),requestKind:'exchange',items:row.items,workflow:{version:2,ref:'AS-atomic',stage:'requested',selectedLines:row.items}};
    const session=await mongo.connection.startSession();
    try{await expect(session.withTransaction(async()=>{await linkComplaintCase(mongo.connection,String(row._id),linked,actor,row.workflow.revision,session);await mongo.connection.collection('returnrequests').insertOne(linked,{session});throw new Error('rollback');})).rejects.toThrow('rollback');}finally{await session.endSession();}
    expect((await service.detail(String(row._id))).workflow.caseId).toBeUndefined();expect(await mongo.connection.collection('returnrequests').countDocuments()).toBe(0);
  });
  it('requires contact attempts before unreachable closure and preserves archived/system history', async () => {
    let row:any=await create();await expect(step(row,'close',{outcome:'unreachable'})).rejects.toThrow();
    row=await step(row,'wait',{waitingFor:'customer'});row=await step(row,'contact',{channel:'phone',contactResult:'no_answer'});
    await Model.updateOne({_id:row._id},{$set:{'workflow.contacts.0.at':new Date(Date.now()-25*3600000).toISOString()}});
    row=await step(row,'contact',{channel:'phone',contactResult:'no_answer'});row=await step(row,'close',{outcome:'unreachable'});expect(row.surveySlug).toBeUndefined();
    row=await step(row,'archive');expect(row.workflow.archivedAt).toBeTruthy();await expect(service.remove(String(row._id))).rejects.toThrow();
    await expect(service.removeNote(String(row._id),row.notes[0].id,actor.userId,true)).rejects.toThrow();
  });
  it('enforces HTTP permissions and DTO validation, including on image evidence endpoints', async () => {
    const row=await create();
    expect((await fetch(base+'/complaints',{headers:{'x-test-role':'viewer'}})).status).toBe(403);
    const result=await fetch(`${base}/complaints/${row._id}/workflow`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationKey:'http-fixture',expectedRevision:0,action:'set-anything',note:'invalid'})});
    expect(result.status).toBe(400);
    expect((await fetch(`${base}/complaints/${row._id}/evidence/anything`,{headers:{'x-test-role':'viewer'}})).status).toBe(403);
  });
  it('sanitizes and deduplicates uploaded evidence without exposing it in public surveys', async () => {
    const row=await create();const buffer=await sharp({create:{width:8,height:8,channels:3,background:'#119944'}}).png().toBuffer();
    const uploaded:any=await service.uploadEvidence(String(row._id),{buffer,originalname:'customer-photo.png'},actor);
    await service.uploadEvidence(String(row._id),{buffer,originalname:'customer-photo.png'},actor);
    const detail=await service.detail(String(row._id));expect(detail.attachments).toHaveLength(1);
    expect((await service.evidenceImage(String(row._id),uploaded.attachments[0].id)).data).toMatch(/^data:image\/webp;base64,/);
    await expect(service.uploadEvidence(String(row._id),{buffer:Buffer.from('<svg/>'),originalname:'unsafe.svg'},actor)).rejects.toThrow();
  });
  it('caps no-return refunds by remaining paid credit across separate complaints', async () => {
    await mongo.connection.collection('transactions').updateOne({_id:sale._id},{$set:{afterSales:null}});
    let first:any=await create();first=await step(first,'plan',{solution:'refund_without_return',amount:400,confirmed:true});
    await step(first,'payment',{method:'كاش',reference:'REFUND-1',confirmed:true});
    let second:any=await create();second=await step(second,'plan',{solution:'refund_without_return',amount:200,confirmed:true});
    await expect(step(second,'payment',{method:'كاش',reference:'REFUND-2',confirmed:true})).rejects.toThrow();
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(1);
    expect((await mongo.connection.collection('transactions').findOne({_id:sale._id}))?.afterSales.complaintRefunded).toBe(400);
  });
  it('requires fresh confirmation after a dispute and disallows replaying a prior execution cycle', async () => {
    let row:any=await create();row=await step(row,'plan',{solution:'support'});row=await step(row,'fulfill',{reference:'CALL-1',confirmed:true});
    row=await step(row,'contact',{channel:'phone',contactResult:'confirmed'});row=await step(row,'contact',{channel:'phone',contactResult:'disputed'});
    await expect(step(row,'close',{outcome:'resolved'})).rejects.toThrow();
    row=await step(row,'close',{outcome:'resolved',customerConfirmed:true});expect(row.workflow.reviewRequired).toBe(false);
    row=await step(row,'reopen');row=await step(row,'plan',{solution:'exchange'});const linked=await execution(row,'exchange',{receivedAt:new Date().toISOString(),replacementDeliveredAt:new Date().toISOString()});
    row=await step(row,'link',{caseId:String(linked._id)});row=await step(row,'close',{outcome:'resolved',customerConfirmed:true});row=await step(row,'reopen');row=await step(row,'plan',{solution:'exchange'});
    await expect(step(row,'link',{caseId:String(linked._id)})).rejects.toThrow();
  });
  it('serializes conflicting decisions from two operators', async () => {
    const row=await create();const results=await Promise.allSettled([step(row,'plan',{solution:'support'}),step(row,'close',{outcome:'rejected'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it.each(['rejected','withdrawn'])('closes an unexecuted complaint with outcome %s and no premature survey',async outcome=>{
    const row=await create();const closed=await step(row,'close',{outcome});expect(closed.workflow.outcome).toBe(outcome);expect(closed.surveyToken).toBeUndefined();expect(closed.inFollowUp).toBe(false);
  });
  it('links duplicates only to a primary complaint of the same customer/order',async()=>{
    const primary=await create(),duplicate=await create();
    const closed=await step(duplicate,'close',{outcome:'duplicate',duplicateId:String(primary._id)});expect(closed.workflow.duplicateId).toBe(String(primary._id));
    const other=await create({clientName:'Other',phone:'01111111111',description:'Unrelated complaint'});
    await expect(step(other,'close',{outcome:'duplicate',duplicateId:String(primary._id)})).rejects.toThrow();
  });
  it('requires cancellation before unlinking execution and supports a new plan afterwards',async()=>{
    let row:any=await create();row=await step(row,'plan',{solution:'exchange'});const linked=await execution(row);row=await step(row,'link',{caseId:String(linked._id)});
    await expect(step(row,'unlink')).rejects.toThrow();await mongo.connection.collection('returnrequests').updateOne({_id:linked._id},{$set:{'workflow.stage':'cancelled'}});
    expect((await service.detail(String(row._id))).lifecycleStage).toBe('blocked');row=await step(row,'unlink');expect(row.workflow.previousCases).toHaveLength(1);
    row=await step(row,'plan',{solution:'support'});expect(row.workflow.solution).toBe('support');
  });
  it('keeps legacy decisions for review without interpreting a manually solved label as proof',async()=>{
    const legacy=await Model.create({complaintNo:'CMP-legacy',description:'Legacy issue',status:'مقبول',managerAction:'استبدال',progressStage:'تم حل المشكلة بنجاح',submittedBy:'Old user',submittedById:actor.userId,phone:'01000000000',inFollowUp:true});
    const view=await service.detail(String(legacy._id));expect(view.workflow.legacy).toBe(true);expect(view.lifecycleStage).toBe('review');expect(view.execution.ready).toBe(false);
    await expect(step(view,'close',{outcome:'resolved',customerConfirmed:true})).rejects.toThrow();
  });
  it('reminds the assigned owner once per due date and excludes closed complaints',async()=>{
    const row=await create();const due=new Date(Date.now()-3600000).toISOString();await Model.updateOne({_id:row._id},{$set:{'workflow.dueAt':due}});
    const notifications:any={enqueue:jest.fn(async()=>{})};const reminders=new ComplaintsService(Model,undefined,notifications);
    await reminders.remindOverdue();await reminders.remindOverdue();expect(notifications.enqueue).toHaveBeenCalledTimes(1);expect(notifications.enqueue.mock.calls[0][4]).toBe(actor.userId);
    await step(await service.detail(String(row._id)),'close',{outcome:'withdrawn'});await Model.updateOne({_id:row._id},{$set:{'workflow.dueAt':new Date(Date.now()-7200000).toISOString()}});
    await reminders.remindOverdue();expect(notifications.enqueue).toHaveBeenCalledTimes(1);
  });
  it('generates customer messages from verified lifecycle state without internal notes',async()=>{
    let row:any=await create();
    const created=await service.customerMessage(String(row._id),'ar','registered');
    expect(created.kind).toBe('registered');expect(created.text).toContain(row.complaintNo);expect(created.text).toContain('#2790');
    expect((await service.customerMessage(String(row._id),'en','resolved')).kind).toBe('update');
    row=await step(row,'plan',{solution:'support'});row=await step(row,'fulfill',{reference:'private-evidence',confirmed:true,note:'private-internal-note'});
    const confirmation=await service.customerMessage(String(row._id),'en');expect(confirmation.kind).toBe('confirmation');expect(confirmation.text).not.toContain('private');
    row=await step(row,'close',{outcome:'partial_agreement',customerConfirmed:true,customerMessage:'Public agreed solution',note:'private-closure-note'});
    const solved=await service.customerMessage(String(row._id),'en');expect(solved.kind).toBe('resolved');expect(solved.text).toContain('Agreed partial resolution');expect(solved.text).toContain('Public agreed solution');expect(solved.text).not.toContain('private');
    row=await step(row,'reopen');row=await step(row,'close',{outcome:'withdrawn'});
    const withdrawn=await service.customerMessage(String(row._id),'en');expect(withdrawn.kind).toBe('closed');expect(withdrawn.text).not.toContain('has been resolved');
  });
  it('persists admin templates, rejects staff changes, unknown tokens and concurrent overwrites',async()=>{
    const row=await create(),config=await service.messageTemplates();
    const templates=structuredClone(config.templates);templates.registered.ar='مرحبًا {customerName} — {complaintNo} — {invoiceRef}';
    await expect(service.saveMessageTemplates({templates,revision:0},{...actor,role:'staff'})).rejects.toThrow();
    const headers={'content-type':'application/json'};
    expect((await fetch(base+'/complaints/message-templates',{method:'PUT',headers:{...headers,'x-test-role':'staff'},body:JSON.stringify({templates,revision:0})})).status).toBe(403);
    const updated=await fetch(base+'/complaints/message-templates',{method:'PUT',headers,body:JSON.stringify({templates,revision:0})});expect(updated.status).toBe(200);
    expect((await service.messageTemplates()).revision).toBe(1);
    const message=await fetch(`${base}/complaints/${row._id}/customer-message?event=registered&lang=ar`);expect(message.status).toBe(200);expect((await message.json()).text).toBe(`مرحبًا Customer — ${row.complaintNo} — #2790`);
    await expect(service.saveMessageTemplates({templates,revision:0},actor)).rejects.toThrow();
    templates.registered.en='{internalNotes}';await expect(service.saveMessageTemplates({templates,revision:1},actor)).rejects.toThrow();
    expect((await service.messageTemplates()).revision).toBe(1);
  });
});
