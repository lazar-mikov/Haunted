import axios from 'axios';

// Prevent multiple simultaneous IFTTT calls
const iftttInProgress = new Set();

export async function triggerIFTTT(effect) {
  const IFTTT_KEY = process.env.IFTTT_WEBHOOK_KEY;
  if (!IFTTT_KEY) {
    console.warn('IFTTT_WEBHOOK_KEY not configured');
    return { success: false, message: 'IFTTT not configured' };
  }

  // Prevent duplicate simultaneous calls
  if (iftttInProgress.has(effect)) {
    console.log(`IFTTT ${effect} already in progress, skipping`);
    return { success: false, message: 'Already in progress' };
  }

  iftttInProgress.add(effect);

  try {
    const response = await axios.post(
      `https://maker.ifttt.com/trigger/haunted_${effect}/with/key/${IFTTT_KEY}`,
      {
        value1: effect,
        value2: 'haunted_trigger',
        value3: new Date().toISOString()
      },
      {
        timeout: 3000, // ✅ 3 second timeout
        validateStatus: () => true // Accept any status (IFTTT always returns 200)
      }
    );
    
    console.log(`IFTTT ${effect} triggered successfully`);
    return { success: true, message: 'IFTTT triggered' };
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error(`IFTTT ${effect} timeout after 3s`);
    } else {
      console.error(`IFTTT ${effect} failed:`, error.message);
    }
    return { success: false, message: error.message };
  } finally {
    iftttInProgress.delete(effect);
  }
}