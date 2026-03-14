/**
 * 価格比較・利益計算モジュール
 *
 * eBayの海外価格と楽天の国内価格を比較し、
 * アービトラージ（価格差）がある商品をランキング化する。
 */

import { getExchangeRates, toJpy } from '../api/exchange.js';

// eBay手数料率（出品カテゴリにより変動、平均的な値を使用）
const EBAY_FEE_RATE = 0.13; // 13%
// PayPal/決済手数料率
const PAYMENT_FEE_RATE = 0.03; // 3%
// 国際送料の概算（商品サイズにより大きく変動）
const DEFAULT_SHIPPING_COST_JPY = 2000;

/**
 * eBayと楽天の検索結果を比較して価格差を分析する
 *
 * 比較ロジック:
 * 1. 楽天で見つかった各商品の国内価格を「仕入れ値」とする
 * 2. eBayで同じキーワードの商品の平均・最高売価を「売値」とする
 * 3. 手数料・送料を差し引いた純利益を計算する
 *
 * @param {Array} ebayItems - eBay API検索結果
 * @param {Array} rakutenItems - 楽天API検索結果
 * @param {object} [options] - オプション
 * @param {number} [options.shippingCostJpy] - 国際送料（円）
 * @returns {Promise<object>} 比較結果
 */
export async function compareProducts(ebayItems, rakutenItems, options = {}) {
    const { shippingCostJpy = DEFAULT_SHIPPING_COST_JPY } = options;
    const rates = await getExchangeRates();

    // eBayの価格をJPYに統一
    const ebayPricesJpy = ebayItems.map(item => ({
        ...item,
        priceJpy: toJpy(item.price, item.currency, rates),
        shippingJpy: item.shippingCost != null
            ? toJpy(item.shippingCost, item.shippingCurrency || 'USD', rates)
            : null,
    }));

    // eBay価格の統計
    const ebayPrices = ebayPricesJpy
        .map(i => i.priceJpy)
        .filter(p => p > 0)
        .sort((a, b) => b - a);

    const ebayStats = {
        count: ebayPrices.length,
        max: ebayPrices[0] || 0,
        min: ebayPrices[ebayPrices.length - 1] || 0,
        avg: ebayPrices.length > 0
            ? Math.round(ebayPrices.reduce((a, b) => a + b, 0) / ebayPrices.length)
            : 0,
        median: ebayPrices.length > 0
            ? ebayPrices[Math.floor(ebayPrices.length / 2)]
            : 0,
    };

    // 楽天の各商品について利益計算
    const opportunities = rakutenItems
        .filter(item => item.price > 0)
        .map(rakutenItem => {
            const buyPrice = rakutenItem.price; // 仕入れ値（円）
            const sellPrice = ebayStats.median || ebayStats.avg; // 想定売価（円換算）

            // eBay手数料
            const ebayFee = Math.round(sellPrice * EBAY_FEE_RATE);
            // 決済手数料
            const paymentFee = Math.round(sellPrice * PAYMENT_FEE_RATE);
            // 純利益
            const netProfit = sellPrice - buyPrice - ebayFee - paymentFee - shippingCostJpy;
            // 利益率
            const profitRate = buyPrice > 0 ? Math.round((netProfit / buyPrice) * 100) : 0;
            // ROI
            const roi = buyPrice > 0 ? Math.round(((sellPrice - buyPrice) / buyPrice) * 100) : 0;

            return {
                // 楽天（仕入れ側）情報
                domesticTitle: rakutenItem.title,
                domesticPrice: buyPrice,
                domesticUrl: rakutenItem.url,
                domesticImageUrl: rakutenItem.imageUrl,
                domesticShop: rakutenItem.shopName,
                domesticReviewCount: rakutenItem.reviewCount,
                domesticReviewAvg: rakutenItem.reviewAverage,

                // eBay（販売側）情報
                ebayAvgPrice: ebayStats.avg,
                ebayMedianPrice: ebayStats.median,
                ebayMaxPrice: ebayStats.max,
                ebayMinPrice: ebayStats.min,
                ebayListingCount: ebayStats.count,

                // 利益計算
                estimatedSellPrice: sellPrice,
                ebayFee,
                paymentFee,
                shippingCost: shippingCostJpy,
                netProfit,
                profitRate,
                roi,

                // メタデータ
                rates: {
                    usdToJpy: rates.usdToJpy,
                },
            };
        })
        .sort((a, b) => b.netProfit - a.netProfit);

    // eBay個別商品リスト（価格が高い順）
    const ebayTopItems = ebayPricesJpy
        .sort((a, b) => b.priceJpy - a.priceJpy)
        .slice(0, 10)
        .map(item => ({
            title: item.title,
            priceJpy: item.priceJpy,
            priceOriginal: `${item.currency} ${item.price}`,
            imageUrl: item.imageUrl,
            url: item.url,
            condition: item.condition,
            location: item.location,
        }));

    return {
        keyword: '',
        searchedAt: new Date().toISOString(),
        rates: { usdToJpy: rates.usdToJpy },
        ebayStats,
        ebayTopItems,
        opportunities,
        summary: {
            totalOpportunities: opportunities.length,
            profitableCount: opportunities.filter(o => o.netProfit > 0).length,
            bestProfit: opportunities.length > 0 ? opportunities[0].netProfit : 0,
            avgProfit: opportunities.length > 0
                ? Math.round(opportunities.reduce((a, b) => a + b.netProfit, 0) / opportunities.length)
                : 0,
        },
    };
}

/**
 * 金額を読みやすい形式にフォーマット
 * @param {number} amount
 * @returns {string}
 */
export function formatJpy(amount) {
    return `¥${Math.round(amount).toLocaleString('ja-JP')}`;
}
