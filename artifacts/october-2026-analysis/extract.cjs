const fs = require('fs');
const path = require('path');
const { MongoClient } = require('../../backend/node_modules/mongodb');
const fields = s => Object.fromEntries(s.split(/\s+/).filter(Boolean).map(k=>[k,1]));
(async()=>{
  const client = await MongoClient.connect('mongodb://127.0.0.1:27018/soulia?replicaSet=souliaDev', {serverSelectionTimeoutMS:5000});
  const session = client.startSession({snapshot:true});
  try {
    const db=client.db();
    const data={extractedAt:new Date().toISOString(), timezone:'Africa/Cairo', cohortMonth:'2026-10', collections:{}};
    const projections={
      shopifyorders: fields('shopifyId ref phone total itemsTotal shipCost status pendingStatus cancelled cancelledAt cancelReason cancelReasonCode cancelReasonNote cancelRequest reviewedAt reviewedBy rejectReason shopifyCreatedAt createdAt updatedAt assignedAt assignedToName depositAmount depositStatus depositDetectedAt shipWithoutDeposit depositReceipts.id depositReceipts.status depositReceipts.amount depositReceipts.submittedAt depositReceipts.reviewedAt depositReceipts.refundedAt depositReceipts.refundReason depositReceipts.vaultTxNo comments notes editHistory rawData.created_at rawData.updated_at rawData.cancelled_at rawData.cancel_reason rawData.test rawData.customer.id rawData.source_name rawData.financial_status rawData.fulfillment_status'),
      transactions: fields('type ref phone date transactionDate createdAt updatedAt shopifyOrderId shopifyCreatedAt confirmedAt total deposit initialDeposit remaining deposits depositReceipts.id depositReceipts.amount depositReceipts.reviewedAt depositReceipts.vaultTxNo cancellationDepositRefunds cancelled cancelledAt cancelReason cancelReasonCode cancelReasonNote cancelRequest cancelStage pickupStatus shippedAt deliveredAt bostaStatus bostaStatusLabel bostaLastSync bostaTrackingEvents shipmentEvents pickupHistory payStatus payments comments notes editHistory afterSales afterSalesEvents carrierCode shipCo'),
      followups: fields('orderRef transactionId shopifyOrderId createdAt updatedAt reason autoSource status comment comments resolution orderOutcome closedAt deferredUntil deferReason deferNote cancelled cancelReason cancelledAt'),
      shopifysyncjobs: fields('status createdAt updatedAt startedAt finishedAt completedAt fromDate toDate counts summary progress'),
    };
    for(const [name,projection] of Object.entries(projections)) data.collections[name]=await db.collection(name).find({}, {projection,session}).toArray();
    fs.writeFileSync(path.join(__dirname,'snapshot.json'),JSON.stringify(data,null,2));
    console.log(JSON.stringify({extractedAt:data.extractedAt,counts:Object.fromEntries(Object.entries(data.collections).map(([k,v])=>[k,v.length]))},null,2));
  } finally {await session.endSession(); await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
