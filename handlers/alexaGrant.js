import axios from 'axios';

export async function handleAcceptGrant(directive, tokenManager) {
  if (directive?.header?.name !== 'AcceptGrant') {
    throw new Error('Invalid directive');
  }

  const grantCode = directive.payload.grant.code;
  const granteeToken = directive.payload.grantee.token;
  
  console.log('Exchanging grant code for event gateway access');
  
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grantCode,
    client_id: process.env.ALEXA_CLIENT_ID,
    client_secret: process.env.ALEXA_CLIENT_SECRET
  });
  
  const tokenResponse = await axios.post(
    'https://api.amazon.com/auth/o2/token', 
    params.toString(),
    { 
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    }
  );
  
  const tokens = tokenResponse.data;
  await tokenManager.storeEventGatewayToken(granteeToken, tokens.access_token, tokens.refresh_token);
  
  return {
    event: {
      header: {
        namespace: "Alexa.Authorization",
        name: "AcceptGrant.Response",
        messageId: directive.header.messageId,
        payloadVersion: "3"
      },
      payload: {}
    }
  };
}