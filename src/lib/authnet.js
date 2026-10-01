'use strict';
const { APIContracts, APIControllers, Constants } = require('authorizenet');

// Credentials are read at call time, never captured at module load, so a
// misconfigured .env fails loudly on first use instead of silently binding
// undefined.
function merchantAuth() {
  const login = process.env.ANET_API_LOGIN_ID;
  const key = process.env.ANET_TRANSACTION_KEY;
  if (!login || !key) {
    throw new Error('ANET_API_LOGIN_ID / ANET_TRANSACTION_KEY are not set. See .env.example.');
  }
  const auth = new APIContracts.MerchantAuthenticationType();
  auth.setName(login);
  auth.setTransactionKey(key);
  return auth;
}

function endpoint() {
  return process.env.ANET_ENV === 'production'
    ? Constants.endpoint.production
    : Constants.endpoint.sandbox;
}

// The SDK is callback-based. Wrapping it once here keeps every call site in
// async/await and keeps error handling in one shape.
function execute(ctrl, ResponseType) {
  return new Promise((resolve, reject) => {
    ctrl.setEnvironment(endpoint());
    ctrl.execute(() => {
      const raw = ctrl.getResponse();
      if (!raw) return reject(new Error('Authorize.Net returned an empty response'));
      const res = new ResponseType(raw);
      const ok = res.getMessages() &&
        res.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK;
      if (!ok) {
        const m = res.getMessages() && res.getMessages().getMessage()[0];
        return reject(Object.assign(
          new Error(m ? `${m.getCode()}: ${m.getText()}` : 'Authorize.Net call failed'),
          { anetCode: m && m.getCode() }
        ));
      }
      resolve(res);
    });
  });
}

/**
 * Coerce an id returned by the SDK into a bare numeric string.
 *
 * The SDK does not consistently hand back a plain value here. Depending on the
 * response shape, a profile id can arrive wrapped in its own quote characters,
 * and passing that straight back into the next request is rejected by the
 * schema:
 *
 *   The value '"937280618"' is invalid according to its datatype
 *   'numericString' - The Pattern constraint failed.
 *
 * Which is a confusing way to be told about a pair of quotation marks. Values
 * crossing this boundary get validated here rather than being trusted, and an
 * id that is not digits stops the process instead of travelling on to become
 * an unreadable schema error two calls later.
 */
function numericId(value, label) {
  const raw = String(value == null ? '' : value).trim().replace(/^"+|"+$/g, '');
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Authorize.Net returned a ${label} that is not numeric: ${JSON.stringify(value)}`);
  }
  return raw;
}

/**
 * Create a CIM customer profile with one payment profile.
 *
 * Card details go straight to Authorize.Net and are exchanged for two ids.
 * Nothing card-shaped is returned to us or stored, which is what keeps this
 * integration inside the narrower PCI scope.
 */
async function createCustomerProfile({ email, card, billTo }) {
  // CIM will create a payment profile with no billing name attached and report
  // success. ARB then refuses to start a subscription against it:
  //
  //   E00014: Bill-To First Name is required.
  //
  // One API accepts a record the other cannot use, and the rejection arrives
  // on a later call, against a profile that already exists. So the requirement
  // is enforced here, at enrolment, where the caller can still do something
  // about it.
  if (!billTo || !billTo.firstName || !billTo.lastName) {
    throw new Error('billTo.firstName and billTo.lastName are required: ARB rejects a payment profile without them');
  }

  const payment = new APIContracts.PaymentType();
  const creditCard = new APIContracts.CreditCardType();
  creditCard.setCardNumber(card.number);
  creditCard.setExpirationDate(card.expiry);
  creditCard.setCardCode(card.cvv);
  payment.setCreditCard(creditCard);

  const address = new APIContracts.CustomerAddressType();
  address.setFirstName(billTo.firstName);
  address.setLastName(billTo.lastName);
  if (billTo.address) address.setAddress(billTo.address);
  if (billTo.city) address.setCity(billTo.city);
  if (billTo.state) address.setState(billTo.state);
  if (billTo.zip) address.setZip(billTo.zip);
  if (billTo.country) address.setCountry(billTo.country);

  const paymentProfile = new APIContracts.CustomerPaymentProfileType();
  paymentProfile.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
  paymentProfile.setBillTo(address);
  paymentProfile.setPayment(payment);

  const profile = new APIContracts.CustomerProfileType();
  profile.setMerchantCustomerId(`m_${Date.now()}`);
  profile.setEmail(email);
  profile.setPaymentProfiles([paymentProfile]);

  const req = new APIContracts.CreateCustomerProfileRequest();
  req.setMerchantAuthentication(merchantAuth());
  req.setProfile(profile);
  req.setValidationMode(APIContracts.ValidationModeEnum.TESTMODE);

  const res = await execute(
    new APIControllers.CreateCustomerProfileController(req.getJSON()),
    APIContracts.CreateCustomerProfileResponse
  );

  const list = res.getCustomerPaymentProfileIdList();
  const ids = list && typeof list.getNumericString === 'function'
    ? list.getNumericString()
    : null;
  if (!ids || !ids.length) {
    throw new Error('Authorize.Net created the profile but returned no payment profile id');
  }

  return {
    customerProfileId: numericId(res.getCustomerProfileId(), 'customerProfileId'),
    paymentProfileId: numericId(ids[0], 'customerPaymentProfileId'),
  };
}

/** Recurring billing (ARB) against an existing CIM profile. */
async function createSubscription({ name, amountCents, cadence, customerProfileId, paymentProfileId, startDate }) {
  // ARB measures intervals in months (1-12) or days. An annual subscription is
  // twelve months rather than a separate unit.
  const interval = new APIContracts.PaymentScheduleType.Interval();
  interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
  interval.setLength(cadence === 'annual' ? 12 : 1);

  const schedule = new APIContracts.PaymentScheduleType();
  schedule.setInterval(interval);
  schedule.setStartDate(startDate || new Date().toISOString().slice(0, 10));
  schedule.setTotalOccurrences(9999); // ARB's value for "until cancelled"

  const profile = new APIContracts.CustomerProfileIdType();
  profile.setCustomerProfileId(numericId(customerProfileId, 'customerProfileId'));
  profile.setCustomerPaymentProfileId(numericId(paymentProfileId, 'customerPaymentProfileId'));

  const sub = new APIContracts.ARBSubscriptionType();
  sub.setName(name);
  sub.setPaymentSchedule(schedule);
  sub.setAmount((amountCents / 100).toFixed(2));
  sub.setProfile(profile);

  const req = new APIContracts.ARBCreateSubscriptionRequest();
  req.setMerchantAuthentication(merchantAuth());
  req.setSubscription(sub);

  const res = await execute(
    new APIControllers.ARBCreateSubscriptionController(req.getJSON()),
    APIContracts.ARBCreateSubscriptionResponse
  );
  return { subscriptionId: res.getSubscriptionId() };
}

async function cancelSubscription(subscriptionId) {
  const req = new APIContracts.ARBCancelSubscriptionRequest();
  req.setMerchantAuthentication(merchantAuth());
  req.setSubscriptionId(subscriptionId);
  await execute(
    new APIControllers.ARBCancelSubscriptionController(req.getJSON()),
    APIContracts.ARBCancelSubscriptionResponse
  );
  return { cancelled: true };
}

module.exports = { createCustomerProfile, createSubscription, cancelSubscription, numericId };
