import Redis from 'ioredis';

export class TokenManager {
  constructor() {
    this.quotaExceeded = false;
    this.memoryTokens = new Map(); // Fallback storage
    
    if (process.env.REDIS_URL) {
      this.initRedis();
    } else {
      console.warn('⚠️ REDIS_URL not set - using in-memory storage (lost on restart)');
      this.redis = null;
    }
  }

  initRedis() {
    if (this.quotaExceeded) {
      console.warn('Redis quota exceeded - using in-memory storage');
      return;
    }

    try {
      this.redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (this.quotaExceeded || times > 3) return null;
          return Math.min(times * 500, 2000);
        },
        reconnectOnError: () => false
      });
      
      this.redis.on('error', (err) => {
        if (err.message.includes('max requests limit exceeded')) {
          this.quotaExceeded = true;
          console.error('❌ Redis quota exceeded - switching to in-memory storage');
          if (this.redis) {
            this.redis.disconnect();
            this.redis = null;
          }
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
    const key = `event_gateway_${granteeToken}`;
    
    // Always store in memory as backup
    this.memoryTokens.set(`token:${key}`, accessToken);
    this.memoryTokens.set(`refresh:${key}`, refreshToken);
    
    if (!this.redis || this.quotaExceeded) {
      console.warn('⚠️ Tokens stored in memory only (will be lost on restart)');
      return;
    }

    try {
      await this.redis.set(`token:${key}`, accessToken, 'EX', 3600);
      await this.redis.set(`refresh:${key}`, refreshToken);
      console.log('✅ Tokens stored in Redis + memory');
    } catch (error) {
      if (error.message.includes('max requests limit exceeded')) {
        this.quotaExceeded = true;
        this.redis = null;
      }
      console.log('⚠️ Redis failed, tokens in memory only');
    }
  }

  async getEventGatewayToken() {
    // Try memory first (faster)
    const memoryKeys = Array.from(this.memoryTokens.keys()).filter(k => k.startsWith('token:event_gateway_'));
    if (memoryKeys.length > 0) {
      return this.memoryTokens.get(memoryKeys[0]);
    }
    
    // Try Redis if available
    if (!this.redis || this.quotaExceeded) return null;
    
    try {
      const keys = await this.redis.keys('token:event_gateway_*');
      if (keys.length === 0) return null;
      const token = await this.redis.get(keys[0]);
      
      // Cache in memory for next time
      if (token) this.memoryTokens.set(keys[0], token);
      
      return token;
    } catch (error) {
      return null;
    }
  }

  async getAllTokenInfo() {
    return {
      totalSessions: this.memoryTokens.size / 2, // Each session has 2 entries
      hasEventGatewayToken: this.getEventGatewayToken() !== null,
      redisConnected: !!this.redis && !this.quotaExceeded,
      usingMemory: this.memoryTokens.size > 0
    };
  }
}