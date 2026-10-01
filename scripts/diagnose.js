'use strict';
/**
 * Work out which Authorize.Net call is failing and why.
 *
 * Prints response codes and messages. Never prints credentials — only whether
 * they are present and how long they are.
 */
require('dotenv').config();
const { APIContracts, APIControllers, Constants } = require('authorizenet');

const login = process.env.ANET_API_LOGIN_ID;
const key = process.env.ANET_TRANSACTION_KEY;
const sig = process.env.ANET_SIGNATURE_KEY;

console.log('\nenvironment');
console.log(`  ANET_ENV               ${process.env.ANET_ENV || '(unset -> sandbox)'}`);
console.log(`  ANET_API_LOGIN_ID      ${login ? `present, ${login.length} chars` : 'MISSING'}`);
console.log(`  ANET_TRANSACTION_KEY   ${key ? `present, ${key.length} chars` : 'MISSING'}`);
console.log(`  ANET_SIGNATURE_KEY     ${sig ? `present, ${sig.length} chars` : 'MISSING'}`);
if (login && /\s/.test(login)) console.log('  WARNING: login id contains whitespace');
if (key && /\s/.test(key)) console.log('  WARNING: transaction key contains whitespace');

function auth() {
  const a = new APIContracts.MerchantAuthenticationType();
  a.setName(login); a.setTransactionKey(key); return a;
}
const endpoint = process.env.ANET_ENV === 'production'
  ? Constants.endpoint.production : Constants.endpoint.sandbox;

function run(ctrl, ResponseType, label) {
  return new Promise(resolve => {
    ctrl.setEnvironment(endpoint);
    ctrl.execute(() => {
      const raw = ctrl.getResponse();
      if (!raw) return resolve({ label, ok: false, note: 'empty response from gateway' });
      const res = new ResponseType(raw);
      const msgs = res.getMessages();
      const code = msgs && msgs.getResultCode();
      const first = msgs && msgs.getMessage() && msgs.getMessage()[0];
      resolve({
        label,
        ok: code === APIContracts.MessageTypeEnum.OK,
        code: first && first.getCode(),
        text: first && first.getText(),
        res,
      });
    });
  });
}

(async () => {
  // 1. Are the credentials themselves valid? This is the call Authorize.Net
  //    provides specifically to answer that, so it isolates auth from CIM.
  const areq = new APIContracts.AuthenticateTestRequest();
  areq.setMerchantAuthentication(auth());
  const a = await run(
    new APIControllers.AuthenticateTestController(areq.getJSON()),
    APIContracts.AuthenticateTestResponse, 'authenticateTest'
  );
  console.log('\n1. credential check');
  console.log(`  ${a.ok ? 'OK' : 'FAIL'}  ${a.code || ''} ${a.text || a.note || ''}`);
  if (!a.ok) {
    console.log('\n  Credentials are being rejected. Check you copied the API Login ID and');
    console.log('  Transaction Key from the SANDBOX account at sandbox.authorize.net,');
    console.log('  not from developer.authorize.net or a production account.\n');
    return;
  }

  // 2. Can we create a CIM profile at all?
  const cc = new APIContracts.CreditCardType();
  cc.setCardNumber('4111111111111111'); cc.setExpirationDate('2030-12'); cc.setCardCode('123');
  const pay = new APIContracts.PaymentType(); pay.setCreditCard(cc);
  const pp = new APIContracts.CustomerPaymentProfileType();
  pp.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL); pp.setPayment(pay);

  const prof = new APIContracts.CustomerProfileType();
  prof.setMerchantCustomerId(`diag_${Date.now()}`);
  prof.setEmail(`diag_${Date.now()}@example.test`);
  prof.setPaymentProfiles([pp]);

  const preq = new APIContracts.CreateCustomerProfileRequest();
  preq.setMerchantAuthentication(auth());
  preq.setProfile(prof);
  preq.setValidationMode(APIContracts.ValidationModeEnum.TESTMODE);

  const p = await run(
    new APIControllers.CreateCustomerProfileController(preq.getJSON()),
    APIContracts.CreateCustomerProfileResponse, 'createCustomerProfile'
  );
  console.log('\n2. create CIM customer profile');
  console.log(`  ${p.ok ? 'OK' : 'FAIL'}  ${p.code || ''} ${p.text || p.note || ''}`);
  if (!p.ok) {
    console.log('\n  E00040 here usually means Customer Information Manager is not enabled');
    console.log('  on this sandbox account. sandbox.authorize.net -> Account -> Merchant');
    console.log('  Profile, or Tools -> Customer Information Manager, and enable it.\n');
    return;
  }

  const profileId = p.res.getCustomerProfileId();
  const list = p.res.getCustomerPaymentProfileIdList();
  const payIds = list && list.getNumericString ? list.getNumericString() : null;
  console.log(`  customerProfileId      ${profileId}`);
  console.log(`  paymentProfileIdList   ${JSON.stringify(payIds)}`);
  if (!payIds || !payIds.length) {
    console.log('\n  The profile was created but no payment profile id came back.');
    console.log('  That is the shape our code assumes — worth knowing.\n');
    return;
  }

  // 3. Can we start a subscription against it?
  const interval = new APIContracts.PaymentScheduleType.Interval();
  interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS); interval.setLength(1);
  const sched = new APIContracts.PaymentScheduleType();
  sched.setInterval(interval);
  sched.setStartDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  sched.setTotalOccurrences(9999);

  const pid = new APIContracts.CustomerProfileIdType();
  pid.setCustomerProfileId(profileId);
  pid.setCustomerPaymentProfileId(payIds[0]);

  const sub = new APIContracts.ARBSubscriptionType();
  sub.setName('diagnostic'); sub.setPaymentSchedule(sched);
  sub.setAmount('25.00'); sub.setProfile(pid);

  const sreq = new APIContracts.ARBCreateSubscriptionRequest();
  sreq.setMerchantAuthentication(auth()); sreq.setSubscription(sub);

  const s = await run(
    new APIControllers.ARBCreateSubscriptionController(sreq.getJSON()),
    APIContracts.ARBCreateSubscriptionResponse, 'ARBCreateSubscription'
  );
  console.log('\n3. create ARB subscription');
  console.log(`  ${s.ok ? 'OK' : 'FAIL'}  ${s.code || ''} ${s.text || s.note || ''}`);
  if (s.ok) console.log(`  subscriptionId         ${s.res.getSubscriptionId()}`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
