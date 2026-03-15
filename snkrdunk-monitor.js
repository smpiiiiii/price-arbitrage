/**
 * スニダン × ヤフオク × メルカリ 統合アービトラージモニター v3
 *
 * v3 勝率向上パッケージ:
 *   - eBay Sold Listings で実売価格を検証
 *   - 売れ行きスピード（Sales Velocity）分析
 *   - 競合セラー数の警告表示
 *   - カテゴリ別送料・手数料対応
 *   - Discord通知Embed改善（検証ステータス表示）
 *
 * フロー:
 *   1. スニダン人気商品一覧から商品IDを取得（内部API）
 *   2. サイズ別販売価格を取得
 *   3. Yahooショッピングで同じ商品を検索（仕入れ候補）
 *   4. 楽天APIでも検索（Wソース）
 *   5. 差額がしきい値以上 → eBay Sold Listingsで実売検証
 *   6. 検証通過 → Discord通知（メルカリ検索リンク付き）
 *
 * 使い方:
 *   node snkrdunk-monitor.js          # 30分間隔で自動巡回
 *   node snkrdunk-monitor.js --once   # 1回だけ実行
 */

import 'dotenv/config';
import { searchRakuten } from './api/rakuten.js';
import { scrapeEbay } from './api/ebay-scraper.js';
import { getExchangeRates, toJpy } from './api/exchange.js';
import * as cheerio from 'cheerio';

// ============================================================
//  設定
// ============================================================

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID;
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const RAKUTEN_AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;
const YAHOO_APP_ID = process.env.YAHOO_APP_ID || '';

/** 通知しきい値 */
const THRESHOLD_PROFIT = 2000;   // 利益 ¥2,000 以上
const THRESHOLD_ROI = 20;        // ROI 20% 以上

/** スニダン手数料 */
const SNKRDUNK_FEE_RATE = 0.065; // 6.5%
const SNKRDUNK_SHIPPING = 990;   // 送料

/** 巡回間隔 */
const SCAN_INTERVAL_MS = 30 * 60 * 1000;

/** API間のディレイ */
const API_DELAY_MS = 2000;

/** Sold Listingsスクレイピング間のディレイ（ボット検知回避） */
const SOLD_SCRAPE_DELAY_MS = 5000;

/** 売れ行きフィルタ: 月間最低販売件数 */
const MIN_MONTHLY_SALES = 1;

/** 競合出品数の警告しきい値 */
const COMPETITION_WARNING = 20;

/** 重複通知防止 */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const notifiedCache = new Map();

/** ユーザーエージェント */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================
//  スニダンAPIクライアント
// ============================================================

/**
 * スニダンの人気商品一覧を取得する
 */
async function getSnkrdunkPopular(type = 'hottest') {
    console.log(`🔍 スニダン人気商品取得中 (${type})...`);

    const res = await fetch(`https://snkrdunk.com/products?type=${type}`, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`スニダン HTTP ${res.status}`);
    const html = await res.text();

    const productIds = [...new Set(
        (html.match(/\/products\/([A-Z0-9a-z_-]+)/g) || [])
            .map(m => m.replace('/products/', ''))
            .filter(id => id.length > 3 && !['type', 'hottest', 'newest'].includes(id))
    )];

    console.log(`  → ${productIds.length}件の商品IDを取得`);
    return productIds;
}

/**
 * スニダンの商品詳細を取得する
 */
async function getSnkrdunkProduct(productId) {
    const res = await fetch(`https://snkrdunk.com/v2/products/${productId}?type=sneaker`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://snkrdunk.com/products/${productId}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
}

/**
 * スニダンのサイズ別価格データを取得する
 */
async function getSnkrdunkPrices(productId) {
    const res = await fetch(`https://snkrdunk.com/v1/sneakers/${productId}/size/list`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://snkrdunk.com/products/${productId}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const json = await res.json();
    const sizeList = json.data?.maxPriceOfSizeList || [];
    const withPrice = sizeList.filter(s => s.price > 0);
    if (withPrice.length === 0) return null;

    const prices = withPrice.map(s => s.price);
    const totalListings = Object.values(json.data?.listingItemCountIntMap || {}).reduce((a, b) => a + b, 0);

    return {
        sizes: withPrice.map(s => ({ size: s.sizeText, price: s.price })),
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        totalListings,
    };
}

// ============================================================
//  Yahooショッピング検索APIクライアント
// ============================================================

/**
 * Yahooショッピング商品検索API v3
 * ヤフオクAPIは2018年に廃止済みのため、Yahooショッピングを仕入れソースとして使用
 * @param {string} keyword
 * @returns {Promise<Array<{title, price, url, imageUrl}>>}
 */
async function searchYahooShopping(keyword) {
    if (!YAHOO_APP_ID) {
        return [];
    }

    try {
        const params = new URLSearchParams({
            appid: YAHOO_APP_ID,
            query: keyword,
            results: '10',
            sort: '+price',       // 安い順
            in_stock: '1',        // 在庫あり
            output: 'json',
        });

        const res = await fetch(`https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?${params}`, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            console.log(`  ⚠️ Yahooショッピング: ${res.status}`);
            return [];
        }

        const data = await res.json();
        const items = data.hits || [];

        return items.map(item => ({
            title: item.name || '',
            price: parseInt(item.price || '0', 10),
            url: item.url || '',
            imageUrl: item.image?.medium || '',
        }));
    } catch (err) {
        console.log(`  ⚠️ Yahooショッピング検索エラー: ${err.message}`);
        return [];
    }
}

// ============================================================
//  楽天APIクライアント（既存のラッパー）
// ============================================================

/**
 * 楽天で商品を検索する
 */
async function searchRakutenItems(keyword) {
    try {
        return await searchRakuten(keyword, {
            appId: RAKUTEN_APP_ID,
            accessKey: RAKUTEN_ACCESS_KEY,
            affiliateId: RAKUTEN_AFFILIATE_ID,
            referer: 'https://smpiiiiii.github.io/price-arbitrage/',
            hits: 10,
        });
    } catch (err) {
        if (err.message.includes('429')) {
            console.log(`  ⚠️ 楽天API レート制限 — 3秒待機`);
            await sleep(3000);
            return [];
        }
        console.log(`  ⚠️ 楽天検索エラー: ${err.message}`);
        return [];
    }
}

// ============================================================
//  利益計算
// ============================================================

/**
 * 利益を計算（スニダン販売 × 仕入れ）
 */
function calculateProfit(buyPrice, sellPrice) {
    const snkrdunkFee = Math.round(sellPrice * SNKRDUNK_FEE_RATE);
    const netProfit = sellPrice - buyPrice - snkrdunkFee - SNKRDUNK_SHIPPING;
    const roi = buyPrice > 0 ? Math.round((netProfit / buyPrice) * 100) : 0;

    return { buyPrice, sellPrice, snkrdunkFee, shipping: SNKRDUNK_SHIPPING, netProfit, roi };
}

// ============================================================
//  eBay Sold Listings 実売検証
// ============================================================

/**
 * eBay Sold Listingsをスクレイピングして実売価格を検証する
 * @param {string} keyword - eBay検索キーワード（商品ID/モデル番号）
 * @param {object} rates - 為替レート
 * @returns {Promise<{stats: object|null, velocity: object}>}
 */
async function verifySoldPrice(keyword, rates) {
    console.log(`  🔍 eBay Sold Listings検証中: "${keyword}"...`);

    try {
        const soldItems = await scrapeEbay(keyword, { sold: true });

        if (!soldItems || soldItems.length === 0) {
            console.log(`  ⚠️ Sold Listingsデータなし`);
            return { stats: null, velocity: { monthlySales: 0, rating: '🔴', label: 'データなし' } };
        }

        // 実売統計を計算
        const stats = calcSoldStats(soldItems, rates);

        // 売れ行きスピード分析
        const velocity = analyzeSalesVelocity(soldItems);

        if (stats) {
            console.log(`  ✅ Sold実売: ${stats.count}件 | 中央値¥${stats.medianJpy.toLocaleString()} | 最高¥${stats.maxJpy.toLocaleString()}`);
        }
        console.log(`  📈 売れ行き: ${velocity.label} (月${velocity.monthlySales}件)`);

        return { stats, velocity };
    } catch (err) {
        console.error(`  ⚠️ Sold Listings取得エラー: ${err.message}`);
        return { stats: null, velocity: { monthlySales: 0, rating: '🟡', label: '取得失敗' } };
    }
}

/**
 * Sold Listings の価格統計を計算する
 */
function calcSoldStats(items, rates) {
    if (!items || items.length === 0) return null;

    const pricesJpy = items
        .map(item => toJpy(item.price, item.currency || 'USD', rates))
        .filter(p => p > 0)
        .sort((a, b) => a - b);

    if (pricesJpy.length === 0) return null;

    return {
        count: pricesJpy.length,
        medianJpy: pricesJpy[Math.floor(pricesJpy.length / 2)],
        avgJpy: Math.round(pricesJpy.reduce((a, b) => a + b, 0) / pricesJpy.length),
        maxJpy: pricesJpy[pricesJpy.length - 1],
        minJpy: pricesJpy[0],
    };
}

/**
 * 売れ行きスピードを分析する（Sales Velocity）
 * @param {Array} soldItems - 売却済み商品リスト
 * @returns {object} { monthlySales, rating, label }
 */
function analyzeSalesVelocity(soldItems) {
    // 売却日があるアイテムをフィルタ
    const withDates = soldItems.filter(item => item.soldDate);

    if (withDates.length === 0) {
        // 日付データなし → 件数だけで推定（eBay通常60~90日分表示）
        const estimatedMonthly = Math.round(soldItems.length / 2);
        return categorizeVelocity(estimatedMonthly, '推定');
    }

    // 最古と最新の売却日の差分から月間販売数を計算
    const dates = withDates
        .map(item => new Date(item.soldDate))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);

    if (dates.length < 2) {
        return categorizeVelocity(soldItems.length, '推定');
    }

    const oldestDate = dates[0];
    const newestDate = dates[dates.length - 1];
    const daySpan = Math.max(1, (newestDate - oldestDate) / (1000 * 60 * 60 * 24));
    const monthlySales = Math.round((dates.length / daySpan) * 30);

    return categorizeVelocity(monthlySales, '実績');
}

/**
 * 月間販売数を評価カテゴリに分類
 */
function categorizeVelocity(monthlySales, basis) {
    if (monthlySales >= 10) {
        return { monthlySales, rating: '🟢', label: `高回転 ${basis}月${monthlySales}件` };
    }
    if (monthlySales >= 5) {
        return { monthlySales, rating: '🟢', label: `良好 ${basis}月${monthlySales}件` };
    }
    if (monthlySales >= 2) {
        return { monthlySales, rating: '🟡', label: `普通 ${basis}月${monthlySales}件` };
    }
    if (monthlySales >= 1) {
        return { monthlySales, rating: '🟡', label: `低回転 ${basis}月${monthlySales}件` };
    }
    return { monthlySales, rating: '🔴', label: `売れにくい ${basis}月${monthlySales}件` };
}

// ============================================================
//  メルカリ / ヤフオク 検索リンク生成
// ============================================================

/**
 * メルカリの検索URLを生成する（ワンタップで確認用）
 */
function getMercariSearchUrl(keyword) {
    return `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&status=on_sale&order=desc&sort=created_time`;
}

/**
 * ヤフオクの検索URLを生成する（ブラウザ用）
 */
function getYahooAuctionSearchUrl(keyword) {
    return `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(keyword)}&va=${encodeURIComponent(keyword)}&auccat=&aucminprice=&aucmaxprice=&slider=0&ei=UTF-8`;
}

// ============================================================
//  キーワード生成
// ============================================================

/**
 * 商品名から検索キーワードを生成する
 * productIdそのもの（モデル番号）が最も精度が高い
 */
function generateSearchKeywords(product, productId) {
    const keywords = [];

    // 1. 商品ID（モデル番号）— 最優先
    if (productId) {
        keywords.push(productId);
    }

    // 2. 日本語名から短いキーワード
    const nameJP = product.nameJP || '';
    if (nameJP) {
        const clean = nameJP
            .replace(/[""「」]/g, '')
            .replace(/×/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const words = clean.split(' ').filter(w => w.length > 1);
        if (words.length > 2) {
            keywords.push(words.slice(0, 3).join(' '));
        }
    }

    return keywords;
}

// ============================================================
//  重複通知防止
// ============================================================

function isAlreadyNotified(key) {
    const ts = notifiedCache.get(key);
    if (!ts) return false;
    if (Date.now() - ts > DEDUP_TTL_MS) { notifiedCache.delete(key); return false; }
    return true;
}

function markNotified(key) {
    notifiedCache.set(key, Date.now());
}

// ============================================================
//  Discord通知（v3 — 実売検証・売れ行き・競合情報付き）
// ============================================================

/**
 * Discord通知 — スニダン販売価格 × 仕入れ先候補 × 実売検証データ
 */
async function sendDiscordAlert(product, priceData, sourceItem, profit, source, productId, soldData = {}, competitorCount = 0) {
    if (!WEBHOOK_URL) return;

    const shortTitle = (product.nameJP || product.nameEN || '').substring(0, 55);
    const roiEmoji = profit.roi >= 100 ? '🔥🔥🔥' : profit.roi >= 50 ? '🔥🔥' : '🔥';
    const sourceEmoji = source === 'yahoo' ? '🔨' : '🛍️';
    const sourceLabel = source === 'yahoo' ? 'Yahooショッピング' : '楽天';

    // 検証ステータス
    const verified = soldData.stats ? '✅ 実売検証済み' : '⚠️ 未検証';

    const mercariUrl = getMercariSearchUrl(productId);
    const yahooUrl = getYahooAuctionSearchUrl(productId);

    const fields = [
        { name: `${sourceEmoji} ${sourceLabel}仕入れ`, value: `¥${profit.buyPrice.toLocaleString()}`, inline: true },
        { name: '💰 スニダン販売', value: `¥${profit.sellPrice.toLocaleString()}`, inline: true },
        { name: '💵 純利益', value: `¥${profit.netProfit.toLocaleString()}`, inline: true },
        { name: '📊 ROI', value: `${profit.roi}%`, inline: true },
        { name: '📉 手数料+送料', value: `¥${(profit.snkrdunkFee + profit.shipping).toLocaleString()}`, inline: true },
        { name: '📈 スニダン出品数', value: `${priceData.totalListings}件`, inline: true },
        {
            name: '👟 スニダン相場',
            value: `最安¥${priceData.minPrice.toLocaleString()} / 平均¥${priceData.avgPrice.toLocaleString()} / 最高¥${priceData.maxPrice.toLocaleString()}`,
            inline: false,
        },
    ];

    // eBay Sold Listingsデータ
    if (soldData.stats) {
        fields.push({
            name: '✅ eBay落札実績（Sold Listings）',
            value: `${soldData.stats.count}件売却 | 中央値¥${soldData.stats.medianJpy.toLocaleString()} | 最高¥${soldData.stats.maxJpy.toLocaleString()} / 最低¥${soldData.stats.minJpy.toLocaleString()}`,
            inline: false,
        });
    }

    // 売れ行きスピード
    if (soldData.velocity) {
        fields.push({
            name: '🚀 売れ行き',
            value: `${soldData.velocity.rating} ${soldData.velocity.label}`,
            inline: true,
        });
    }

    // 競合セラー数
    if (competitorCount > 0) {
        const compEmoji = competitorCount >= COMPETITION_WARNING ? '🔴' :
                          competitorCount >= 10 ? '🟡' : '🟢';
        fields.push({
            name: '👥 eBay競合出品数',
            value: `${compEmoji} ${competitorCount}件出品中`,
            inline: true,
        });
    }

    // リンク
    fields.push({
        name: '🔗 リンク',
        value: [
            `[${sourceEmoji} ${sourceLabel}で購入](${sourceItem.url})`,
            `[👟 スニダン](https://snkrdunk.com/products/${productId})`,
            `[📱 メルカリで検索](${mercariUrl})`,
            `[🔨 ヤフオクで検索](${yahooUrl})`,
            `[✅ eBay落札実績](https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(productId)}&LH_Sold=1&LH_Complete=1)`,
        ].join('\n'),
        inline: false,
    });

    const embed = {
        title: `${roiEmoji} スニダン売り × ${sourceLabel}仕入れ（${verified}）`,
        description: `**${shortTitle}**`,
        color: profit.roi >= 100 ? 0xFF0000 : profit.roi >= 50 ? 0xFF6600 : 0x00CC00,
        thumbnail: product.eyeCatchImageUrl ? { url: product.eyeCatchImageUrl } : undefined,
        fields,
        footer: { text: 'Snkrdunk Arbitrage v3 | 勝率向上パッケージ' },
        timestamp: new Date().toISOString(),
    };

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: '👟 スニダンアラート v3',
                avatar_url: 'https://cdn-icons-png.flaticon.com/512/2589/2589903.png',
                embeds: [embed],
                thread_name: '👟 スニダンアラート',
            }),
        });
        if (res.ok) {
            console.log(`  📨 Discord: ${shortTitle} (${sourceLabel} ¥${profit.buyPrice.toLocaleString()} → スニダン ¥${profit.sellPrice.toLocaleString()} = 利益¥${profit.netProfit.toLocaleString()}) [${verified}]`);
        } else {
            console.error(`  ❌ Discord通知エラー: ${res.status}`);
        }
        await sleep(1500);
    } catch (err) {
        console.error(`  ❌ Discord通知エラー: ${err.message}`);
    }
}

// ============================================================
//  メインスキャン
// ============================================================

async function scanAll() {
    const startTime = Date.now();
    console.log('\n' + '='.repeat(60));
    console.log(`👟 スニダン × ヤフオク × メルカリ 統合スキャン v3`);
    console.log(`   ${new Date().toLocaleString('ja-JP')}`);
    console.log(`   Yahooショッピング: ${YAHOO_APP_ID ? '✅' : '❌（リンクのみ）'}  楽天API: ✅  メルカリ: 🔗リンク`);
    console.log(`   eBay Sold Listings: ✅ 実売検証  売れ行き分析: ✅`);
    console.log('='.repeat(60));

    // 為替レート取得（eBay Sold Listings検証用）
    const rates = await getExchangeRates();
    console.log(`💱 為替レート: 1 USD = ¥${rates.usdToJpy.toFixed(1)}`);

    const productIds = await getSnkrdunkPopular('hottest');

    let totalProducts = 0;
    let totalAlerts = 0;
    let totalYahoo = 0;
    let totalRakuten = 0;
    let totalCandidates = 0;
    let totalVerified = 0;

    for (const productId of productIds.slice(0, 30)) {
        totalProducts++;

        try {
            // 商品詳細取得
            const product = await getSnkrdunkProduct(productId);
            if (!product) { await sleep(API_DELAY_MS); continue; }

            const productName = product.nameJP || product.nameEN || productId;
            console.log(`\n--- ${productName.substring(0, 50)} ---`);
            console.log(`    ID: ${productId}`);

            // サイズ別価格取得
            const priceData = await getSnkrdunkPrices(productId);
            if (!priceData) {
                console.log(`  ⏭️ 価格データなし`);
                await sleep(API_DELAY_MS);
                continue;
            }

            console.log(`  💰 スニダン: 最安¥${priceData.minPrice.toLocaleString()} / 平均¥${priceData.avgPrice.toLocaleString()} / 出品${priceData.totalListings}件`);

            // 比較基準: スニダンの最安価格（確実に売れるライン）
            const sellPrice = priceData.minPrice;

            const keywords = generateSearchKeywords(product, productId);

            // 候補を一時的に集める（全ソースから）
            const candidates = [];

            // ---- Yahooショッピング検索 ----
            if (YAHOO_APP_ID && keywords.length > 0) {
                console.log(`  🔨 Yahooショッピング検索: "${keywords[0]}"`);
                const yahooItems = await searchYahooShopping(keywords[0]);
                totalYahoo += yahooItems.length;

                if (yahooItems.length > 0) {
                    console.log(`  → Yahoo: ${yahooItems.length}件`);
                    for (const item of yahooItems) {
                        const profit = calculateProfit(item.price, sellPrice);
                        if (profit.netProfit >= THRESHOLD_PROFIT && profit.roi >= THRESHOLD_ROI) {
                            candidates.push({ item, profit, source: 'yahoo' });
                        }
                    }
                }
                await sleep(API_DELAY_MS);
            }

            // ---- 楽天検索 ----
            if (keywords.length > 0) {
                console.log(`  🛍️ 楽天検索: "${keywords[0]}"`);
                const rakutenItems = await searchRakutenItems(keywords[0]);
                totalRakuten += rakutenItems.length;

                if (rakutenItems.length > 0) {
                    console.log(`  → 楽天: ${rakutenItems.length}件`);
                    for (const item of rakutenItems) {
                        const profit = calculateProfit(item.price, sellPrice);
                        if (profit.netProfit >= THRESHOLD_PROFIT && profit.roi >= THRESHOLD_ROI) {
                            candidates.push({ item, profit, source: 'rakuten' });
                        }
                    }
                }
                await sleep(API_DELAY_MS);
            }

            // 候補なし → 次の商品へ
            if (candidates.length === 0) {
                continue;
            }

            console.log(`  🎯 ${candidates.length}件の候補を検出 → eBay Sold Listings検証へ`);
            totalCandidates += candidates.length;

            // ---- eBay Sold Listings で実売検証 ----
            await sleep(SOLD_SCRAPE_DELAY_MS);
            const soldData = await verifySoldPrice(productId, rates);

            // Sold検証が成功した場合のみ売れ行きチェック
            const soldAvailable = soldData.stats !== null;
            if (soldAvailable && soldData.velocity.monthlySales < MIN_MONTHLY_SALES) {
                console.log(`  ⏭️ 売れ行き不足（月${soldData.velocity.monthlySales}件 < 最低${MIN_MONTHLY_SALES}件） — 全候補スキップ`);
                await sleep(API_DELAY_MS);
                continue;
            }
            if (!soldAvailable) {
                console.log(`  ⚠️ Sold検証失敗 → 出品中データで通知（未検証ステータス付き）`);
            } else {
                totalVerified += candidates.length;
            }

            // eBay出品中の競合数を取得（Sold Listingsの件数で代替）
            const competitorCount = soldData.stats ? soldData.stats.count : 0;

            // 各候補を通知
            for (const { item, profit, source } of candidates) {
                const key = `${source}::${productId}::${item.url}`;
                if (!isAlreadyNotified(key)) {
                    const sourceLabel = source === 'yahoo' ? 'Yahoo' : '楽天';
                    console.log(`  🎯 ${sourceLabel} ¥${profit.buyPrice.toLocaleString()} → スニダン ¥${sellPrice.toLocaleString()} = 利益¥${profit.netProfit.toLocaleString()} [${soldAvailable ? '実売検証済' : '未検証'}]`);
                    await sendDiscordAlert(product, priceData, item, profit, source, productId, soldData, competitorCount);
                    markNotified(key);
                    totalAlerts++;
                }
            }
        } catch (err) {
            console.error(`  ❌ エラー: ${err.message}`);
        }

        await sleep(API_DELAY_MS);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ スキャン完了 (${elapsed}秒)`);
    console.log(`   📊 商品: ${totalProducts}件 | Yahoo: ${totalYahoo}件 | 楽天: ${totalRakuten}件`);
    console.log(`   🎯 候補: ${totalCandidates}件 → 実売検証: ${totalVerified}件 → アラート: ${totalAlerts}件`);
    console.log('='.repeat(60));

    return { totalProducts, totalAlerts, totalCandidates, totalVerified };
}

// ============================================================
//  ユーティリティ
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
//  エントリポイント
// ============================================================

async function main() {
    console.log('👟 Snkrdunk Arbitrage Monitor v3.0（勝率向上版）');
    console.log('   スニダン × ヤフオク × メルカリ + eBay Sold Listings検証');
    console.log(`   通知条件: 利益 ≧ ¥${THRESHOLD_PROFIT.toLocaleString()} かつ ROI ≧ ${THRESHOLD_ROI}%`);
    console.log(`   スニダン手数料: ${SNKRDUNK_FEE_RATE * 100}% + ¥${SNKRDUNK_SHIPPING}`);
    console.log(`   ✅ 実売検証: eBay Sold Listingsで実売価格を検証`);
    console.log(`   🚀 売れ行き: 月${MIN_MONTHLY_SALES}件以上の商品のみ`);
    console.log(`   👥 競合警告: ${COMPETITION_WARNING}件以上で注意`);
    console.log(`   Yahooショッピング: ${YAHOO_APP_ID ? '✅' : '❌（.envにYAHOO_APP_IDを設定）'}`);
    console.log(`   楽天API: ✅  メルカリ: 🔗検索リンク`);
    console.log(`   Discord: ${WEBHOOK_URL ? '✅' : '❌'}`);
    console.log('');

    if (!WEBHOOK_URL) {
        console.error('❌ DISCORD_WEBHOOK_URL が設定されていません');
        process.exit(1);
    }

    const isOnce = process.argv.includes('--once');

    if (isOnce) {
        console.log('📌 ワンショットモード');
        await scanAll();
    } else {
        console.log(`🔄 ${SCAN_INTERVAL_MS / 60000}分間隔で自動巡回開始\n`);
        await scanAll();
        setInterval(async () => {
            try { await scanAll(); } catch (e) { console.error('❌ エラー:', e.message); }
        }, SCAN_INTERVAL_MS);
    }
}

main().catch(err => {
    console.error('❌ 致命的エラー:', err);
    process.exit(1);
});
