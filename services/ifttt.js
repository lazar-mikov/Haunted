import axios from 'axios';

export async function triggerIFTTT(effect) {
  const IFTTT_KEY = process.env.IFTTT_WEBHOOK_KEY;
  if (!IFTTT_KEY) {
    console.warn('IFTTT_WEBHOOK_KEY not configured');
    return { success: false, message: 'IFTTT not configured' };
  }

  try {
    await axios.post(
      `https://maker.ifttt.com/trigger/haunted_${effect}/with/key/${IFTTT_KEY}`,
      {
        value1: effect,
        value2: 'haunted_trigger',
        value3: new Date().toISOString()
      }
    );
    return { success: true, message: 'IFTTT triggered' };
  } catch (error) {
    console.error('IFTTT trigger failed:', error.message);
    return { success: false, message: error.message };
  }
}