'use strict';
/** What shape do the ids actually have, coming out of the SDK and out of Postgres? */
require('dotenv').config();
const { APIContracts, APIControllers, Constants } = require('authorizenet');
const { pool } = require('../src/db/pool');

function show(label, v) {
  console.log(`  ${label.padEnd(26)} typeof=${typeof v}  JSON=${JSON.stringify(v)}`);
  if (typeof v === 'string') {
    console.log(`  ${''.padEnd(26)} chars=[${[...v].slice(0,3).map(c=>c.charCodeAt(0)).join(',')}...]  length=${v.length}`);
  }
}

(async () => {
  console.log('\n--- straight out of the SDK ---');
  const cc = new APIContracts.CreditCardType();
  cc.setCardNumber('4111111111111111'); cc.setExpirationDate('2030-12'); cc.setCardCode('123');
  const pay = new APIContracts.PaymentType(); pay.setCreditCard(cc);
  const pp = new APIContracts.CustomerPaymentProfileType();
  pp.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL); pp.setPayment(pay);
  const prof = new APIContracts.CustomerProfileType();
  prof.setMerchantCustomerId(`insp_${Date.now()}`);
  prof.setEmail(`insp_${Date.now()}@example.test`);
  prof.setPaymentProfiles([pp]);
  const auth = new APIContracts.MerchantAuthenticationType();
  auth.setName(process.env.ANET_API_LOGIN_ID);
  auth.setTransactionKey(process.env.ANET_TRANSACTION_KEY);
  const req = new APIContracts.CreateCustomerProfileRequest();
  req.setMerchantAuthentication(auth); req.setProfile(prof);
  req.setValidationMode(APIContracts.ValidationModeEnum.TESTMODE);

  const ctrl = new APIControllers.CreateCustomerProfileController(req.getJSON());
  ctrl.setEnvironment(Constants.endpoint.sandbox);
  const res = await new Promise(r => ctrl.execute(() =>
    r(new APIContracts.CreateCustomerProfileResponse(ctrl.getResponse()))));

  show('getCustomerProfileId()', res.getCustomerProfileId());
  const list = res.getCustomerPaymentProfileIdList();
  show('...IdList()', list);
  const arr = list && list.getNumericString();
  show('...getNumericString()', arr);
  if (Array.isArray(arr)) show('...getNumericString()[0]', arr[0]);

  console.log('\n--- what Postgres is holding ---');
  const { rows } = await pool.query(
    `select email, anet_customer_profile_id, anet_payment_profile_id
       from members order by created_at desc limit 3`);
  for (const r of rows) {
    console.log(`  ${r.email}`);
    show('  customer_profile_id', r.anet_customer_profile_id);
    show('  payment_profile_id', r.anet_payment_profile_id);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
