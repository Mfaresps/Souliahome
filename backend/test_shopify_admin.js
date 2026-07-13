const https = require('https');

const STORE = 'soulia-2';
const TOKEN = 'REDACTED_SHOPIFY_TOKEN';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options = {
      hostname: `${STORE}.myshopify.com`,
      path: `/admin/api/2024-01${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('=== TEST 1: Shopify Admin API Connection ===');
  const shop = await request('GET', '/shop.json');
  if (shop.status === 200) {
    console.log(`PASS - متصل بـ Shopify: ${shop.body.shop?.name} (${shop.body.shop?.domain})`);
  } else {
    console.log(`FAIL - HTTP ${shop.status}: ${JSON.stringify(shop.body)}`);
    return;
  }

  console.log('\n=== TEST 2: جلب آخر أوردر من شوبيفاي ===');
  const orders = await request('GET', '/orders.json?limit=3&status=any');
  if (orders.status === 200) {
    const list = orders.body.orders || [];
    console.log(`PASS - عدد الأوردرات: ${list.length}`);
    list.forEach(o => {
      console.log(`  - Order #${o.order_number} | ${o.name} | id=${o.id} | status=${o.financial_status} | fulfillment=${o.fulfillment_status || 'unfulfilled'}`);
    });
    if (list.length > 0) {
      global.TEST_ORDER_ID = list[0].id;
      global.TEST_ORDER_NAME = list[0].name;
      global.TEST_ORDER_TOTAL = list[0].total_price;
    }
  } else {
    console.log(`FAIL - HTTP ${orders.status}: ${JSON.stringify(orders.body)}`);
  }

  if (global.TEST_ORDER_ID) {
    console.log(`\n=== TEST 3: جلب Fulfillment Orders للأوردر ${global.TEST_ORDER_NAME} ===`);
    const fo = await request('GET', `/orders/${global.TEST_ORDER_ID}/fulfillment_orders.json`);
    if (fo.status === 200) {
      const foList = fo.body.fulfillment_orders || [];
      console.log(`PASS - Fulfillment Orders: ${foList.length}`);
      foList.forEach(f => console.log(`  - fo_id=${f.id} status=${f.status}`));
    } else {
      console.log(`FAIL - HTTP ${fo.status}: ${JSON.stringify(fo.body)}`);
    }
  }

  console.log('\n=== TEST 4: صلاحيات API (Scopes) ===');
  const access = await request('GET', '/access_scopes.json');
  if (access.status === 200) {
    const scopes = (access.body.access_scopes || []).map(s => s.handle).join(', ');
    console.log(`PASS - Scopes: ${scopes}`);
  } else {
    console.log(`INFO - HTTP ${access.status} (قد لا تكون متاحة في Custom Apps)`);
  }

  console.log('\n=== النتيجة ===');
  console.log('الاتصال بـ Shopify Admin API يعمل بنجاح ✅');
  console.log(`استخدم Order ID: ${global.TEST_ORDER_ID} للاختبار اليدوي`);
}

run().catch(e => console.error('ERROR:', e.message));
