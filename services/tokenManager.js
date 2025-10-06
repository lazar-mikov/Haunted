import Redis from 'ioredis';
import axios from 'axios';

export class TokenManager {
  constructor() {
    this.quotaExceeded = false;
    this.memoryTokens = new Map();
    this.tokenToGrantee = new Map();
    
    if (process.env.REDIS_URL) {
      this.initRedis();
    } else {
      console.warn('REDIS_URL not set - using in-memory storage');
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
          console.error('Redis quota exceeded - switching to in-memory storage');
          if (this.redis) {
            this.redis.disconnect();
            this.redis = null;
          }
        }
      });
      
      this.redis.on('connect', () => {
        console.log('Redis connected');
      });
      
    } catch (error) {
      console.error('Redis initialization failed:', error.message);
      this.redis = null;
    }
  }

  async storeEventGatewayToken(granteeToken, accessToken, refreshToken) {
    const key = `event_gateway_${granteeToken}`;
    
    this.tokenToGrantee.set(accessToken, granteeToken);
    
    this.memoryTokens.set(`token:${key}`, accessToken);
    this.memoryTokens.set(`refresh:${key}`, refreshToken);
    this.memoryTokens.set(`grantee:${key}`, granteeToken);
    
    if (!this.redis || this.quotaExceeded) {
      console.warn('Tokens stored in memory only (lost on restart)');
      return;
    }

    try {
      await this.redis.set(`token:${key}`, accessToken, 'EX', 3600);
      await this.redis.set(`refresh:${key}`, refreshToken);
      await this.redis.set(`grantee:${key}`, granteeToken);
      console.log('Tokens stored in Redis + memory');
    } catch (error) {
      if (error.message.includes('max requests limit exceeded')) {
        this.quotaExceeded = true;
        this.redis = null;
      }
      console.log('Redis failed, tokens in memory only');
    }
  }

  async refreshAccessToken(accessToken) {
    let granteeToken = this.tokenToGrantee.get(accessToken);
    
    if (!granteeToken) {
      console.error('Cannot refresh: no grantee token found for access token');
      return null;
    }
    
    const key = `event_gateway_${granteeToken}`;
    
    let refreshToken = this.memoryTokens.get(`refresh:${key}`);
    
    if (!refreshToken && this.redis && !this.quotaExceeded) {
      try {
        refreshToken = await this.redis.get(`refresh:${key}`);
      } catch (error) {
        console.error('Failed to get refresh token from Redis');
      }
    }
    
    if (!refreshToken) {
      console.error('No refresh token available');
      return null;
    }
    
    try {
      console.log('Refreshing access token...');
      
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.ALEXA_CLIENT_ID,
        client_secret: process.env.ALEXA_CLIENT_SECRET
      });
      
      const response = await axios.post(
        'https://api.amazon.com/auth/o2/token',
        params.toString(),
        { 
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        }
      );
      
      const newAccessToken = response.data.access_token;
      
      this.tokenToGrantee.delete(accessToken);
      this.tokenToGrantee.set(newAccessToken, granteeToken);
      
      this.memoryTokens.set(`token:${key}`, newAccessToken);
      
      if (this.redis && !this.quotaExceeded) {
        try {
          await this.redis.set(`token:${key}`, newAccessToken, 'EX', 3600);
        } catch (error) {
          console.log('Failed to store refreshed token in Redis');
        }
      }
      
      console.log('Access token refreshed successfully');
      return newAccessToken;
    } catch (error) {
      console.error('Failed to refresh token:', error.response?.data || error.message);
      return null;
    }
  }

  async getEventGatewayToken() {
    const memoryKeys = Array.from(this.memoryTokens.keys())
      .filter(k => k.startsWith('token:event_gateway_'));
    if (memoryKeys.length > 0) {
      return this.memoryTokens.get(memoryKeys[0]);
    }
    
    if (!this.redis || this.quotaExceeded) return null;
    
    try {
      const keys = await this.redis.keys('token:event_gateway_*');
      if (keys.length === 0) return null;
      const token = await this.redis.get(keys[0]);
      
      if (token) this.memoryTokens.set(keys[0], token);
      
      return token;
    } catch (error) {
      return null;
    }
  }

  async getAllEventGatewayTokens() {
    const tokenObjects = [];
    
    const memoryKeys = Array.from(this.memoryTokens.keys())
      .filter(k => k.startsWith('token:event_gateway_'));
    
    for (const key of memoryKeys) {
      const token = this.memoryTokens.get(key);
      const granteeToken = key.replace('token:event_gateway_', '');
      
      if (token) {
        tokenObjects.push({ 
          accessToken: token, 
          granteeToken: granteeToken 
        });
        
        this.tokenToGrantee.set(token, granteeToken);
      }
    }
    
    if (this.redis && !this.quotaExceeded) {
      try {
        const redisKeys = await this.redis.keys('token:event_gateway_*');
        for (const key of redisKeys) {
          const token = await this.redis.get(key);
          const granteeToken = key.replace('token:event_gateway_', '');
          
          if (token && !tokenObjects.find(t => t.accessToken === token)) {
            tokenObjects.push({ 
              accessToken: token, 
              granteeToken: granteeToken 
            });
            
            this.tokenToGrantee.set(token, granteeToken);
          }
        }
      } catch (error) {
        // Redis failed, use memory tokens only
      }
    }
    
    console.log(`Retrieved ${tokenObjects.length} user tokens for broadcast`);
    return tokenObjects;
  }

  async getAllTokenInfo() {
    const memoryCount = Array.from(this.memoryTokens.keys())
      .filter(k => k.startsWith('token:event_gateway_')).length;
    
    return {
      totalSessions: memoryCount,
      hasEventGatewayToken: memoryCount > 0,
      redisConnected: !!this.redis && !this.quotaExceeded,
      usingMemory: this.memoryTokens.size > 0
    };
  }
}