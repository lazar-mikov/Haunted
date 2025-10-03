import Redis from 'ioredis';

export class TokenManager {
  constructor() {
    this.quotaExceeded = false;
    if (process.env.REDIS_URL) {
      this.initRedis();
    } else {
      console.warn('⚠️ REDIS_URL not set - tokens will be lost on restart');
      this.redis = null;
    }
  }

  initRedis() {
    if (this.quotaExceeded) {
      console.warn('Redis quota exceeded - staying disconnected');
      return;
    }

    try {
      this.redis = new Redis(process.env.REDIS_URL, {
        retryStrategy: (times) => {
          if (this.quotaExceeded) return null; // Stop retrying
          if (times > 5) return null; // Give up after 5 attempts
          return Math.min(times * 1000, 3000);
        },
        reconnectOnError: (err) => {
          if (err.message.includes('max requests limit exceeded')) {
            this.quotaExceeded = true;
            return false; // Don't reconnect on quota errors
          }
          return true;
        },
        maxRetriesPerRequest: 1,
        enableReadyCheck: true
      });
      
      this.redis.on('error', (err) => {
        if (err.message.includes('max requests limit exceeded')) {
          this.quotaExceeded = true;
          console.error('❌ Redis quota exceeded - disabling Redis');
          if (this.redis) {
            this.redis.disconnect();
            this.redis = null;
          }
        } else {
          console.error('Redis error:', err.message);
        }
      });
      
      this.redis.on('connect', () => {
        console.log('✅ Redis connected');
      });
      
    } catch (error) {
      console.error('Redis initialization failed:', error.message);
      this.redis = null;
    }
  }

  async storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    if (!this.redis || this.quotaExceeded) {
      console.warn('⚠️ Redis not available - tokens not persisted');
      return;
    }

    try {
      await this.redis.set(`token:event_gateway_${granteeToken}`, accessToken, 'EX', 3600);
      await this.redis.set(`refresh:event_gateway_${granteeToken}`, refreshToken);
      console.log('✅ Tokens stored in Redis');
    } catch (error) {
      if (error.message.includes('max requests limit exceeded')) {
        this.quotaExceeded = true;
        this.redis = null;
      }
      console.error('Failed to store in Redis:', error.message);
    }
  }

  async getEventGatewayToken() {
    if (!this.redis || this.quotaExceeded) return null;
    
    try {
      const keys = await this.redis.keys('token:event_gateway_*');
      if (keys.length === 0) return null;
      return await this.redis.get(keys[0]);
    } catch (error) {
      if (error.message.includes('max requests limit exceeded')) {
        this.quotaExceeded = true;
        this.redis = null;
      }
      return null;
    }
  }

  async getAllTokenInfo() {
    if (!this.redis || this.quotaExceeded) {
      return { 
        totalSessions: 0, 
        hasEventGatewayToken: false,
        redisConnected: false,
        quotaExceeded: this.quotaExceeded
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