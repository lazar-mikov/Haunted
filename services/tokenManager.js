import Redis from 'ioredis';

export class TokenManager {
  constructor() {
    if (process.env.REDIS_URL) {
      try {
        this.redis = new Redis(process.env.REDIS_URL, {
          retryStrategy: () => null, // Don't retry on connection failure
          maxRetriesPerRequest: 1
        });
        
        this.redis.on('error', (err) => {
          console.error('Redis error:', err.message);
          this.redis = null; // Disable Redis on error
        });
        
        this.redis.on('connect', () => {
          console.log('✅ Redis connected');
        });
      } catch (error) {
        console.error('Redis initialization failed:', error.message);
        this.redis = null;
      }
    } else {
      console.warn('⚠️ REDIS_URL not set - tokens will be lost on restart');
      this.redis = null;
    }
  }

  async storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    const key = `event_gateway_${granteeToken}`;
    
    if (this.redis) {
      try {
        await this.redis.set(`token:${key}`, accessToken, 'EX', 3600);
        await this.redis.set(`refresh:${key}`, refreshToken);
        console.log('✅ Event Gateway tokens stored in Redis');
      } catch (error) {
        console.error('Failed to store in Redis:', error.message);
      }
    } else {
      console.warn('⚠️ Redis not available - tokens not persisted');
    }
  }

  async getEventGatewayToken() {
    if (!this.redis) return null;
    
    try {
      const keys = await this.redis.keys('token:event_gateway_*');
      if (keys.length === 0) return null;
      return await this.redis.get(keys[0]);
    } catch (error) {
      console.error('Failed to read from Redis:', error.message);
      return null;
    }
  }

  async getAllTokenInfo() {
    if (!this.redis) {
      return { 
        totalSessions: 0, 
        hasEventGatewayToken: false,
        redisConnected: false 
      };
    }
    
    try {
      const tokenKeys = await this.redis.keys('token:event_gateway_*');
      return {
        totalSessions: tokenKeys.length,
        hasEventGatewayToken: tokenKeys.length > 0,
        redisConnected: true
      };
    } catch (error) {
      return { 
        totalSessions: 0, 
        hasEventGatewayToken: false,
        redisConnected: false,
        error: error.message
      };
    }
  }
}