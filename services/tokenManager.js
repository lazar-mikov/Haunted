import Redis from 'ioredis';

export class TokenManager {
  constructor() {
    this.redis = process.env.REDIS_URL 
      ? new Redis(process.env.REDIS_URL)
      : null;
    
    if (!this.redis) {
      console.warn('Redis not configured - tokens will be lost on restart');
    } else {
      console.log('Redis connected');
    }
  }

  async storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    const key = `event_gateway_${granteeToken}`;
    
    if (this.redis) {
      await this.redis.set(`token:${key}`, accessToken, 'EX', 3600);
      await this.redis.set(`refresh:${key}`, refreshToken);
    }
    
    console.log('Event Gateway tokens stored');
  }

  async getEventGatewayToken() {
    if (!this.redis) return null;
    
    const keys = await this.redis.keys('token:event_gateway_*');
    if (keys.length === 0) return null;
    
    return await this.redis.get(keys[0]);
  }

  async getAllTokenInfo() {
    if (!this.redis) {
      return { 
        totalSessions: 0, 
        hasEventGatewayToken: false,
        redisConnected: false 
      };
    }
    
    const tokenKeys = await this.redis.keys('token:event_gateway_*');
    return {
      totalSessions: tokenKeys.length,
      hasEventGatewayToken: tokenKeys.length > 0,
      redisConnected: true
    };
  }
}