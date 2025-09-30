export class TokenManager {
  constructor() {
    this.alexaUserSessions = new Map();
    this.alexaRefreshTokens = new Map();
  }

  storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    const key = `event_gateway_${granteeToken}`;
    this.alexaUserSessions.set(key, accessToken);
    this.alexaRefreshTokens.set(key, refreshToken);
    console.log('Event Gateway tokens stored for user');
  }

  getEventGatewayToken() {
    for (const [key, token] of this.alexaUserSessions.entries()) {
      if (key.startsWith('event_gateway_')) {
        return token;
      }
    }
    return null;
  }

  storeAccountLinkToken(accessToken, refreshToken) {
    this.alexaUserSessions.set('alexa_main_tokens', accessToken);
    this.alexaRefreshTokens.set('alexa_main_tokens', refreshToken);
  }

  getAllTokenInfo() {
    return {
      totalSessions: this.alexaUserSessions.size,
      totalRefreshTokens: this.alexaRefreshTokens.size,
      hasEventGatewayToken: this.getEventGatewayToken() !== null
    };
  }
}