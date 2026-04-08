const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/soulia', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const db = mongoose.connection;

db.on('connected', async () => {
  console.log('✅ متصل بقاعدة البيانات');
  
  try {
    const collections = [
      'transactions',
      'vaultentries',
      'clients',
      'returnrequests',
      'expenses',
      'complaints'
    ];

    for (const collection of collections) {
      try {
        const result = await db.collection(collection).deleteMany({});
        console.log(`✅ تم مسح ${collection}: ${result.deletedCount} سجل`);
      } catch (e) {
        console.log(`⚠️ ${collection}: لا توجد بيانات`);
      }
    }

    console.log('\n✅ تم تفريغ قاعدة البيانات بنجاح!');
    console.log('🔄 الآن بإمكانك البدء من جديد - أعد تحميل الصفحة');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ خطأ:', error);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error('❌ تأكد من تشغيل MongoDB');
  process.exit(1);
}, 5000);
