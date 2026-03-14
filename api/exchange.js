/**
 * 為替レート取得モジュール
 *
 * open.er-api.com から為替レートを取得し、1時間キャッシュする。
 * 既存プロジェクト（analyzer.js）のロジックを流用。
 */

// 為替レートキャッシュ（1時間有効）
let rateCache = { usdToJpy: 150, eurToJpy: 162, gbpToJpy: 190, timestamp: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 為替レートを取得する（キャッシュ付き）
 * @returns {Promise<{usdToJpy: number, eurToJpy: number, gbpToJpy: number}>}
 */
export async function getExchangeRates() {
    if (Date.now() - rateCache.timestamp < CACHE_TTL_MS) {
        return rateCache;
    }

    try {
        const res = await fetch('https://open.er-api.com/v6/latest/JPY', {
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();

        if (data.result === 'success' && data.rates) {
            rateCache = {
                usdToJpy: data.rates.USD ? 1 / data.rates.USD : 150,
                eurToJpy: data.rates.EUR ? 1 / data.rates.EUR : 162,
                gbpToJpy: data.rates.GBP ? 1 / data.rates.GBP : 190,
                timestamp: Date.now(),
            };
            console.log(`💱 為替レート更新: 1 USD = ¥${rateCache.usdToJpy.toFixed(1)}`);
        }
    } catch (err) {
        console.error(`⚠️ 為替レート取得エラー（キャッシュ使用）: ${err.message}`);
    }

    return rateCache;
}

/**
 * 金額を通貨コードに応じてJPYに変換
 * @param {number} amount - 金額
 * @param {string} currency - 通貨コード
 * @param {{usdToJpy: number, eurToJpy: number, gbpToJpy: number}} rates
 * @returns {number}
 */
export function toJpy(amount, currency, rates) {
    switch (currency) {
        case 'JPY': return amount;
        case 'USD': return Math.round(amount * rates.usdToJpy);
        case 'EUR': return Math.round(amount * rates.eurToJpy);
        case 'GBP': return Math.round(amount * rates.gbpToJpy);
        default: return Math.round(amount * rates.usdToJpy);
    }
}
