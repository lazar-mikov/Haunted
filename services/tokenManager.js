import Redis from 'ioredis';

export class TokenManager {
  constructor() {
    if (process.env.REDIS_URL) {
      this.initRedis();
    } else {
      console.warn('⚠️ REDIS_URL not set - tokens will be lost on restart');
      this.redis = null;
    }
  }

  initRedis() {
    try {
      this.redis = new Redis(process.env.REDIS_URL, {
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        reconnectOnError: (err) => {
          console.log('Redis reconnecting due to:', err.message);
          return true;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false
      });
      
      this.redis.on('error', (err) => {
        console.error('Redis error:', err.message);
      });
      
      this.redis.on('connect', () => {
        console.log('✅ Redis connected');
      });

      this.redis.on('close', () => {
        console.warn('⚠️ Redis connection closed');
      });

      this.redis.on('reconnecting', () => {
        console.log('🔄 Redis reconnecting...');
      });
      
    } catch (error) {
      console.error('Redis initialization failed:', error.message);
      this.redis = null;
    }
  }

  async ensureConnection() {
    if (!this.redis) return false;
    
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      console.warn('Redis ping failed, reinitializing...');
      this.initRedis();
      return false;
    }
  }

  async storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    const key = `event_gateway_${granteeToken}`;
    
    if (!this.redis) {
      console.warn('⚠️ Redis not available - tokens not persisted');
      return;
    }

    try {
      await this.ensureConnection();
      await this.redis.set(`token:${key}`, accessToken, 'EX', 3600);
      await this.redis.set(`refresh:${key}`, refreshToken);
      console.log('✅ Event Gateway tokens stored in Redis');
    } catch (error) {
      console.error('Failed to store in Redis:', error.message);
    }
  }

  async getEventGatewayToken() {
    if (!this.redis) return null;
    
    try {
      await this.ensureConnection();
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
      await this.ensureConnection();
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