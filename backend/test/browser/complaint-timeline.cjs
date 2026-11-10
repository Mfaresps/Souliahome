/* Long audit histories use the real complaint page with isolated fixture APIs. */
process.env.COMPLAINT_TIMELINE_REVIEW='1';
require('./complaint-page.cjs');
