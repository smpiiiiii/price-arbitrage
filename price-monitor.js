/**
 * 価格差モニター v4 — eBay Sold Listings検証 + 勝率向上パッケージ
 *
 * 公式APIで候補検出 → Sold Listingsで実売価格検証 →
 * 売れ行き・競合数も加味して判定。
 *
 * 通知条件:
 *   - ROI 200%以上、または 純利益 ¥5,000以上
 *   - Sold Listingsで実売価格を検証済み
 *   - 月間販売1件以上（在庫リスク回避）
 *
 * 使い方:
 *   node price-monitor.js          # 30分間隔で自動巡回
 *   node price-monitor.js --once   # 1回だけ実行
 */

import 'dotenv/config';
import { searchEbay } from './api/ebay.js';
import { scrapeEbay } from './api/ebay-scraper.js';
import { searchRakuten } from './api/rakuten.js';
import { getExchangeRates, toJpy } from './api/exchange.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ============================================================
//  グローバルクラッシュハンドラ（プロセスが絶対に落ちないようにする）
// ============================================================

process.on('uncaughtException', (err) => {
    console.error('🛡️ [uncaughtException] キャッチされなかった例外:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('🛡️ [unhandledRejection] 未処理のPromise拒否:', reason);
});


// ============================================================
//  設定
// ============================================================

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN || '';

/** 通知しきい値（調整可能） */
const THRESHOLD_ROI = 200;       // ROI 200% 以上
const THRESHOLD_PROFIT = 5000;   // 利益 ¥5,000 以上

/** 巡回間隔（ミリ秒） */
const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30分

/** 各キーワード間のディレイ（レート制限対策） */
const KEYWORD_DELAY_MS = 3000; // 3秒

/** Sold Listingsスクレイピング間のディレイ */
const SOLD_SCRAPE_DELAY_MS = 5000; // 5秒（ボット検知回避）

/** 重複通知防止（24時間以内の同一商品は再通知しない） */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/** eBay実売データの鮮度（時間） */
const FRESHNESS_HOURS = 48;

/** 売れ行きフィルタ: 月間最低販売件数（これ以下はスキップ） */
const MIN_MONTHLY_SALES = 1;

/** 競合出品数の警告しきい値 */
const COMPETITION_WARNING = 20;

/** eBay API設定 */
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID;
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const RAKUTEN_AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;

/** 価格トラッキングファイル */
const PRICE_HISTORY_FILE = './price-history.json';

/**
 * 監視キーワード — カテゴリ別送料・手数料付き
 * - shippingCost: 国際送料（円）
 * - feeRate: eBayカテゴリ別手数料率
 */
const MONITOR_KEYWORDS = [
    {
        label: '🤖 ねんどろいど限定',
        ebayKeyword: 'nendoroid limited exclusive japan',
        rakutenKeyword: 'ねんどろいど 限定',
        shippingCost: 1500,   // 小型フィギュア
        feeRate: 0.1235,      // コレクティブル
    },
    {
        label: '🎭 figma',
        ebayKeyword: 'figma figure japan',
        rakutenKeyword: 'figma フィギュア',
        shippingCost: 1800,   // 中型フィギュア
        feeRate: 0.1235,
    },
    {
        label: '🔧 ガンプラ MG',
        ebayKeyword: 'gundam MG master grade model kit',
        rakutenKeyword: 'ガンプラ MG マスターグレード',
        shippingCost: 3000,   // 大型箱
        feeRate: 0.1235,
    },
    {
        label: '🔧 ガンプラ HG',
        ebayKeyword: 'gundam HG high grade model kit',
        rakutenKeyword: 'ガンプラ HG ハイグレード',
        shippingCost: 2000,   // 中型箱
        feeRate: 0.1235,
    },
    {
        label: '⚔️ METAL BUILD',
        ebayKeyword: 'gundam metal build figure',
        rakutenKeyword: 'METAL BUILD ガンダム',
        shippingCost: 3500,   // 大型・重量
        feeRate: 0.1235,
    },
    {
        label: '🏪 無印良品',
        ebayKeyword: 'MUJI japan',
        rakutenKeyword: '無印良品',
        shippingCost: 2000,
        feeRate: 0.13,
    },
    {
        label: '🥃 ウイスキーグラス',
        ebayKeyword: 'japanese whisky glass',
        rakutenKeyword: 'ウイスキー グラス 日本製',
        shippingCost: 2500,   // 壊れ物・梱包厚め
        feeRate: 0.13,
    },
    {
        label: '🔪 日本製包丁',
        ebayKeyword: 'japanese knife santoku',
        rakutenKeyword: '包丁 三徳',
        shippingCost: 2000,
        feeRate: 0.13,
    },
    {
        label: '🎮 レトロゲーム',
        ebayKeyword: 'retro game japan famicom nintendo',
        rakutenKeyword: 'レトロゲーム ファミコン',
        shippingCost: 1500,   // 軽量
        feeRate: 0.1235,
    },
    {
        label: '🤖 アニメフィギュア',
        ebayKeyword: 'anime figure japan limited sealed',
        rakutenKeyword: 'フィギュア 限定 未開封',
        shippingCost: 2500,   // 大型フィギュア
        feeRate: 0.1235,
    },
];

/** 決済手数料（全カテゴリ共通） */
const PAYMENT_FEE_RATE = 0.03;

// ============================================================
//  重複通知防止
// ============================================================

/** 通知済み商品のキャッシュ（キー → タイムスタンプ） */
const notifiedCache = new Map();

/**
 * 通知済みかチェック（24時間以内の同一商品を重複排除）
 * @param {string} key - 一意キー
 * @returns {boolean} 既に通知済みならtrue
 */
function isAlreadyNotified(key) {
    const ts = notifiedCache.get(key);
    if (!ts) return false;
    if (Date.now() - ts > DEDUP_TTL_MS) {
        notifiedCache.delete(key);
        return false;
    }
    return true;
}

/**
 * 通知済みとしてマーク
 * @param {string} key
 */
function markNotified(key) {
    notifiedCache.set(key, Date.now());
    // 古いエントリを掃除
    for (const [k, ts] of notifiedCache) {
        if (Date.now() - ts > DEDUP_TTL_MS) notifiedCache.delete(k);
    }
}

// ============================================================
//  価格トラッキング
// ============================================================

/**
 * 価格履歴を読み込む
 */
function loadPriceHistory() {
    try {
        if (existsSync(PRICE_HISTORY_FILE)) {
            return JSON.parse(readFileSync(PRICE_HISTORY_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

/**
 * 価格履歴を保存する
 */
function savePriceHistory(history) {
    writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * 価格変動を記録し、トレンドを分析する
 */
function trackPrice(keyword, ebayMedian, rakutenMin) {
    const history = loadPriceHistory();
    if (!history[keyword]) history[keyword] = [];

    const now = new Date().toISOString();
    history[keyword].push({ date: now, ebayMedian, rakutenMin });

    // 最大100件保持
    if (history[keyword].length > 100) {
        history[keyword] = history[keyword].slice(-100);
    }
    savePriceHistory(history);

    // トレンド分析（直近5回分）
    const recent = history[keyword].slice(-5);
    if (recent.length < 2) return { trend: 'unknown', change: 0 };

    const prevSpread = recent[0].ebayMedian - recent[0].rakutenMin;
    const currSpread = ebayMedian - rakutenMin;
    const change = currSpread - prevSpread;
    const trend = change > 500 ? 'up' : change < -500 ? 'down' : 'stable';

    return { trend, change, dataPoints: recent.length };
}

// ============================================================
//  利益計算（カテゴリ別コスト対応）
// ============================================================

/**
 * eBay統計データと楽天仕入れ価格から利益を計算
 * @param {object} rakutenItem - 楽天商品
 * @param {object} ebayStats - eBay価格統計
 * @param {object} categoryConfig - カテゴリ別設定
 */
function calculateProfit(rakutenItem, ebayStats, categoryConfig = {}) {
    const buyPrice = rakutenItem.price;
    const sellPrice = ebayStats.medianJpy;
    const feeRate = categoryConfig.feeRate || 0.13;
    const shippingCost = categoryConfig.shippingCost || 2000;

    const ebayFee = Math.round(sellPrice * feeRate);
    const paymentFee = Math.round(sellPrice * PAYMENT_FEE_RATE);
    const netProfit = sellPrice - buyPrice - ebayFee - paymentFee - shippingCost;
    const roi = buyPrice > 0 ? Math.round((netProfit / buyPrice) * 100) : 0;

    return {
        domesticTitle: rakutenItem.title,
        domesticPrice: buyPrice,
        domesticUrl: rakutenItem.url,
        estimatedSellPrice: sellPrice,
        ebayFee,
        paymentFee,
        shippingCost,
        feeRate,
        netProfit,
        roi,
        ebaySoldCount: ebayStats.count,
        ebayMedianPrice: ebayStats.medianJpy,
        ebayMaxPrice: ebayStats.maxJpy,
        ebayMinPrice: ebayStats.minJpy,
    };
}

/**
 * eBay APIレスポンスから統計を計算
 */
function calcEbayStats(items, rates) {
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

// ============================================================
//  Sold Listings 検証
// ============================================================

/**
 * eBay Sold Listingsをスクレイピングして実売価格を検証する
 * @param {string} keyword - eBay検索キーワード
 * @param {object} rates - 為替レート
 * @returns {Promise<{stats: object|null, velocity: object}>}
 */
async function verifySoldPrice(keyword, rates) {
    console.log(`  🔍 Sold Listings検証中: "${keyword}"...`);

    try {
        const soldItems = await scrapeEbay(keyword, { sold: true });

        if (!soldItems || soldItems.length === 0) {
            console.log(`  ⚠️ Sold Listingsデータなし`);
            return { stats: null, velocity: { monthlySales: 0, rating: '🔴', label: 'データなし' } };
        }

        // 実売統計を計算
        const stats = calcEbayStats(soldItems, rates);

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
 * 売れ行きスピードを分析する（Sales Velocity）
 * @param {Array} soldItems - 売却済み商品リスト
 * @returns {object} { monthlySales, rating, label }
 */
function analyzeSalesVelocity(soldItems) {
    // 売却日があるアイテムをフィルタ
    const withDates = soldItems.filter(item => item.soldDate);

    if (withDates.length === 0) {
        // 日付データなし → 件数だけで推定
        // eBayの検索結果は通常直近60~90日分を表示
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
//  Discord Webhook 送信（拡張版）
// ============================================================

/**
 * Discord Webhookに通知を送信（実売データ・売れ行き・競合情報付き）
 */
async function sendDiscordNotification(result, label, ebayKeyword, soldData = {}, competitorCount = 0) {
    if (!WEBHOOK_URL) {
        console.log('⚠️ DISCORD_WEBHOOK_URL が設定されていません');
        return;
    }

    const profitSign = result.netProfit >= 0 ? '+' : '';
    const roiEmoji = result.roi >= 1000 ? '🔥🔥🔥' : result.roi >= 500 ? '🔥🔥' : '🔥';

    // タイトルを短縮
    const shortTitle = result.domesticTitle.length > 60
        ? result.domesticTitle.substring(0, 57) + '...'
        : result.domesticTitle;

    // 検証ステータス
    const verified = soldData.stats ? '✅ 実売検証済み' : '⚠️ 出品中価格ベース';

    const embed = {
        title: `${roiEmoji} 価格差アラート（${verified}）`,
        description: `**${shortTitle}**`,
        color: result.roi >= 1000 ? 0xFF0000 : result.roi >= 500 ? 0xFF6600 : 0x00CC00,
        fields: [
            { name: '🏷️ 楽天仕入れ', value: `¥${result.domesticPrice.toLocaleString()}`, inline: true },
            { name: '💰 売価（中央値）', value: `¥${result.estimatedSellPrice.toLocaleString()}`, inline: true },
            { name: '📊 ROI', value: `${result.roi}%`, inline: true },
            { name: '💵 純利益', value: `${profitSign}¥${result.netProfit.toLocaleString()}`, inline: true },
            { name: '📉 手数料', value: `¥${(result.ebayFee + result.paymentFee).toLocaleString()} (${Math.round(result.feeRate * 100)}%+3%)`, inline: true },
            { name: '📦 送料', value: `¥${result.shippingCost.toLocaleString()}`, inline: true },
        ],
        footer: { text: `Price Arbitrage v4 • ${verified}` },
        timestamp: new Date().toISOString(),
    };

    // Sold Listingsデータ
    if (soldData.stats) {
        embed.fields.push({
            name: `✅ eBay落札実績（Sold Listings）`,
            value: `${soldData.stats.count}件売却 | 中央値¥${soldData.stats.medianJpy.toLocaleString()} | 最高¥${soldData.stats.maxJpy.toLocaleString()} / 最低¥${soldData.stats.minJpy.toLocaleString()}`,
            inline: false,
        });
    } else {
        embed.fields.push({
            name: `📈 eBay出品中`,
            value: `${result.ebaySoldCount}件出品中 | 中央値¥${result.ebayMedianPrice.toLocaleString()}`,
            inline: false,
        });
    }

    // 売れ行きスピード
    if (soldData.velocity) {
        embed.fields.push({
            name: '🚀 売れ行き',
            value: `${soldData.velocity.rating} ${soldData.velocity.label}`,
            inline: true,
        });
    }

    // 競合セラー数
    if (competitorCount > 0) {
        const compEmoji = competitorCount >= COMPETITION_WARNING ? '🔴' :
                          competitorCount >= 10 ? '🟡' : '🟢';
        embed.fields.push({
            name: '👥 競合出品数',
            value: `${compEmoji} ${competitorCount}件出品中`,
            inline: true,
        });
    }

    // カテゴリ
    embed.fields.push({ name: '📂 カテゴリ', value: label, inline: true });

    // リンク
    if (result.domesticUrl) {
        embed.url = result.domesticUrl;
    }

    const ebayLinks = [
        `[🛒 楽天で購入](${result.domesticUrl})`,
        `[✅ eBay落札実績](https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebayKeyword)}&LH_Sold=1&LH_Complete=1&_sop=13)`,
        `[🔍 eBay出品中](https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebayKeyword)}&_sop=13)`,
    ].join(' | ');
    embed.fields.push({ name: '🔗 リンク', value: ebayLinks, inline: false });

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: '💰 価格アラート（eBay）',
                avatar_url: 'https://cdn-icons-png.flaticon.com/512/2331/2331941.png',
                embeds: [embed],
            }),
        });

        if (res.ok) {
            console.log(`  📨 Discord通知送信: ${shortTitle} (ROI: ${result.roi}%, 利益: ¥${result.netProfit.toLocaleString()})`);
        } else {
            console.error(`  ❌ Discord通知エラー: ${res.status} ${await res.text()}`);
        }

        // レート制限対策
        await sleep(1500);
    } catch (err) {
        console.error(`  ❌ Discord通知エラー: ${err.message}`);
    }
}

// ============================================================
//  LINE Notify 送信
// ============================================================

/**
 * LINE Notifyに通知を送信
 */
async function sendLineNotification(result, label, soldData = {}) {
    if (!LINE_NOTIFY_TOKEN) return;

    const profitSign = result.netProfit >= 0 ? '+' : '';
    const shortTitle = result.domesticTitle.length > 40
        ? result.domesticTitle.substring(0, 37) + '...'
        : result.domesticTitle;

    const verified = soldData.stats ? '✅実売検証済' : '⚠️出品価格ベース';
    const velocityInfo = soldData.velocity ? `\n📈 ${soldData.velocity.label}` : '';

    const message = `
🔥 価格差アラート（${verified}）
📦 ${shortTitle}
🏷️ 仕入れ: ¥${result.domesticPrice.toLocaleString()}
💰 売価: ¥${result.estimatedSellPrice.toLocaleString()}
💵 利益: ${profitSign}¥${result.netProfit.toLocaleString()}
📊 ROI: ${result.roi}%${velocityInfo}
📂 ${label}
🛒 ${result.domesticUrl || ''}`;

    try {
        await fetch('https://notify-api.line.me/api/notify', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LINE_NOTIFY_TOKEN}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `message=${encodeURIComponent(message)}`,
        });
        console.log(`  📱 LINE通知送信完了`);
    } catch (err) {
        console.error(`  ❌ LINE通知エラー: ${err.message}`);
    }
}

// ============================================================
//  メインスキャン
// ============================================================

/**
 * 全キーワードを巡回して価格差を検出 → Sold検証 → 通知
 */
async function scanAll() {
    const startTime = Date.now();
    console.log('\n' + '='.repeat(60));
    console.log(`🔍 価格差スキャン開始 — ${new Date().toLocaleString('ja-JP')}`);
    console.log(`   📡 eBay Browse API × 楽天 → Sold Listings検証`);
    console.log('='.repeat(60));

    // 為替レート取得
    const rates = await getExchangeRates();
    console.log(`💱 為替レート: 1 USD = ¥${rates.usdToJpy.toFixed(1)}`);

    let totalEbay = 0;
    let totalRakuten = 0;
    let totalCandidates = 0;
    let totalVerified = 0;
    let totalAlerts = 0;

    for (const kwConfig of MONITOR_KEYWORDS) {
        const { label, ebayKeyword, rakutenKeyword } = kwConfig;

        console.log(`\n--- ${label} ---`);
        console.log(`    eBay: "${ebayKeyword}" / 楽天: "${rakutenKeyword}"`);
        console.log(`    📦送料: ¥${kwConfig.shippingCost.toLocaleString()} / 手数料: ${Math.round(kwConfig.feeRate * 100)}%`);

        try {
            // eBay Browse APIで検索（出品中の価格）
            console.log(`  📦 eBay API検索中...`);
            const ebayItems = await searchEbay(ebayKeyword, {
                clientId: EBAY_CLIENT_ID,
                clientSecret: EBAY_CLIENT_SECRET,
                limit: 20,
            });
            totalEbay += ebayItems.length;

            // 競合出品数 = Browse APIの結果件数
            const competitorCount = ebayItems.length;

            const ebayStats = calcEbayStats(ebayItems, rates);
            if (!ebayStats) {
                console.log(`  ⏭️ eBayデータなし — スキップ`);
                await sleep(KEYWORD_DELAY_MS);
                continue;
            }

            console.log(`  ✅ eBay出品中: ${ebayStats.count}件 | 中央値¥${ebayStats.medianJpy.toLocaleString()} | 最高¥${ebayStats.maxJpy.toLocaleString()}`);

            if (competitorCount >= COMPETITION_WARNING) {
                console.log(`  ⚠️ 競合多数: ${competitorCount}件出品中 — 価格競争に注意`);
            }

            // 楽天APIで仕入れ候補を検索
            console.log(`  🛍️ 楽天API検索中...`);
            const rakutenItems = await searchRakuten(rakutenKeyword, {
                appId: RAKUTEN_APP_ID,
                accessKey: RAKUTEN_ACCESS_KEY,
                affiliateId: RAKUTEN_AFFILIATE_ID,
                referer: 'https://smpiiiiii.github.io/price-arbitrage/',
                hits: 20,
                usedExcludeFlag: true,
            });
            totalRakuten += rakutenItems.length;
            console.log(`  → 楽天: ${rakutenItems.length}件取得`);

            if (rakutenItems.length === 0) {
                await sleep(KEYWORD_DELAY_MS);
                continue;
            }

            // 価格変動トラッキング
            const rakutenMin = Math.min(...rakutenItems.map(i => i.price).filter(p => p > 0));
            const priceTrack = trackPrice(label, ebayStats.medianJpy, rakutenMin);
            if (priceTrack.trend === 'up') {
                console.log(`  📈 価格差拡大中！ (+¥${priceTrack.change.toLocaleString()})`);
            } else if (priceTrack.trend === 'down') {
                console.log(`  📉 価格差縮小中 (¥${priceTrack.change.toLocaleString()})`);
            }

            // ---- 第1段階: 出品中価格で候補スクリーニング ----
            const candidates = [];
            for (const rakutenItem of rakutenItems) {
                const result = calculateProfit(rakutenItem, ebayStats, kwConfig);
                if (result.roi >= THRESHOLD_ROI || result.netProfit >= THRESHOLD_PROFIT) {
                    candidates.push({ rakutenItem, result });
                }
            }

            if (candidates.length === 0) {
                console.log(`  → 候補なし（しきい値未満）`);
                await sleep(KEYWORD_DELAY_MS);
                continue;
            }

            console.log(`  🎯 ${candidates.length}件の候補を検出 → Sold Listings検証へ`);
            totalCandidates += candidates.length;

            // ---- 第2段階: Sold Listingsで実売検証 ----
            await sleep(SOLD_SCRAPE_DELAY_MS);
            const soldData = await verifySoldPrice(ebayKeyword, rates);

            // Sold検証が成功した場合のみ売れ行きチェック
            const soldAvailable = soldData.stats !== null;
            if (soldAvailable && soldData.velocity.monthlySales < MIN_MONTHLY_SALES) {
                console.log(`  ⏭️ 売れ行き不足（月${soldData.velocity.monthlySales}件 < 最低${MIN_MONTHLY_SALES}件） — 全候補スキップ`);
                await sleep(KEYWORD_DELAY_MS);
                continue;
            }
            if (!soldAvailable) {
                console.log(`  ⚠️ Sold検証失敗 → 出品中データで通知（未検証ステータス付き）`);
            }

            // 各候補を実売価格で再検証
            for (const { rakutenItem, result: initialResult } of candidates) {
                const dedupKey = `${rakutenItem.url}::${ebayKeyword}`;
                if (isAlreadyNotified(dedupKey)) {
                    console.log(`  ⏭️ 通知済みスキップ: ${rakutenItem.title.substring(0, 40)}...`);
                    continue;
                }

                // Sold Listingsデータがあれば実売価格で再計算
                let finalResult = initialResult;
                if (soldData.stats) {
                    finalResult = calculateProfit(rakutenItem, soldData.stats, kwConfig);
                    totalVerified++;

                    const diff = finalResult.netProfit - initialResult.netProfit;
                    console.log(`  🔄 再計算: 利益 ¥${initialResult.netProfit.toLocaleString()} → ¥${finalResult.netProfit.toLocaleString()} (${diff >= 0 ? '+' : ''}¥${diff.toLocaleString()})`);

                    // 再計算後もしきい値を超えるかチェック
                    if (finalResult.roi < THRESHOLD_ROI && finalResult.netProfit < THRESHOLD_PROFIT) {
                        console.log(`  ❌ 実売価格ベースではしきい値未満 — スキップ`);
                        continue;
                    }
                }

                console.log(`  🎯 ヒット! ROI: ${finalResult.roi}% 利益: ¥${finalResult.netProfit.toLocaleString()} — ${rakutenItem.title.substring(0, 40)}...`);

                // Discord + LINE 通知
                await sendDiscordNotification(finalResult, label, ebayKeyword, soldData, competitorCount);
                await sendLineNotification(finalResult, label, soldData);
                markNotified(dedupKey);
                totalAlerts++;
            }
        } catch (err) {
            console.error(`  ❌ エラー: ${err.message}`);
        }

        await sleep(KEYWORD_DELAY_MS);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ スキャン完了 (${elapsed}秒)`);
    console.log(`   📊 eBay: ${totalEbay}件 / 楽天: ${totalRakuten}件`);
    console.log(`   🎯 候補: ${totalCandidates}件 → 実売検証: ${totalVerified}件 → 通知: ${totalAlerts}件`);
    console.log('='.repeat(60));

    return { totalEbay, totalRakuten, totalCandidates, totalVerified, totalAlerts };
}

/**
 * スキャン開始時のサマリー通知
 */
async function sendStartupNotification() {
    if (!WEBHOOK_URL) return;

    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: '💰 価格アラート（eBay）',
                avatar_url: 'https://cdn-icons-png.flaticon.com/512/2331/2331941.png',
                embeds: [{
                    title: '🚀 価格モニター v4 起動（勝率向上版）',
                    description: [
                        `**📡 データソース**: eBay Browse API + Sold Listings + 楽天API`,
                        `**📋 監視**: ${MONITOR_KEYWORDS.map(k => k.label).join(', ')}`,
                        `**🎯 通知条件**: ROI ≧ ${THRESHOLD_ROI}% or 利益 ≧ ¥${THRESHOLD_PROFIT.toLocaleString()}`,
                        `**✅ 実売検証**: Sold Listingsで実売価格を検証`,
                        `**🚀 売れ行き**: 月${MIN_MONTHLY_SALES}件以上の商品のみ`,
                        `**👥 競合警告**: ${COMPETITION_WARNING}件以上で注意`,
                        `**📦 送料**: カテゴリ別（¥1,500〜¥3,500）`,
                        `**🔄 巡回**: ${SCAN_INTERVAL_MS / 60000}分間隔`,
                    ].join('\n'),
                    color: 0x00AAFF,
                    timestamp: new Date().toISOString(),
                }],
            }),
        });
    } catch { /* 起動通知失敗は無視 */ }
}

// ============================================================
//  ユーティリティ
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
//  エントリポイント
// ============================================================

/** 連続エラーカウンタ */
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function main() {
    console.log('💰 Price Arbitrage Monitor v4.1（クラッシュ耐性強化版）');
    console.log(`   📡 eBay Browse API + Sold Listings × 楽天公式API`);
    console.log(`   通知条件: ROI ≧ ${THRESHOLD_ROI}% または 利益 ≧ ¥${THRESHOLD_PROFIT.toLocaleString()}`);
    console.log(`   ✅ 実売検証: Sold Listingsで実売価格を検証`);
    console.log(`   🚀 売れ行き: 月${MIN_MONTHLY_SALES}件以上の商品のみ`);
    console.log(`   👥 競合警告: ${COMPETITION_WARNING}件以上で注意`);
    console.log(`   📦 送料: カテゴリ別（¥1,500〜¥3,500）`);
    console.log(`   🛡️ クラッシュ耐性: グローバルハンドラ + クールダウン`);
    console.log(`   監視: ${MONITOR_KEYWORDS.map(k => k.label).join(', ')}`);
    console.log(`   Discord: ${WEBHOOK_URL ? '✅' : '❌'}  LINE: ${LINE_NOTIFY_TOKEN ? '✅' : '❌（設定すればLINEにも通知）'}`);
    console.log('');

    if (!WEBHOOK_URL && !LINE_NOTIFY_TOKEN) {
        console.error('❌ 通知先が設定されていません。');
        console.error('   .env に DISCORD_WEBHOOK_URL か LINE_NOTIFY_TOKEN を設定してください');
        process.exit(1);
    }

    if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
        console.error('❌ eBay APIキーが設定されていません。');
        process.exit(1);
    }

    const isOnce = process.argv.includes('--once');

    if (isOnce) {
        console.log('📌 ワンショットモード（--once）');
        try {
            await scanAll();
        } catch (e) {
            console.error(`❌ スキャンエラー: ${e.message}`);
        }
    } else {
        await sendStartupNotification();
        console.log(`🔄 ${SCAN_INTERVAL_MS / 60000}分間隔で自動巡回開始\n`);

        try {
            await scanAll();
            consecutiveErrors = 0;
        } catch (e) {
            console.error(`❌ 初回スキャンエラー: ${e.message}`);
            consecutiveErrors++;
        }

        setInterval(async () => {
            try {
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.log(`⏸️ 連続エラー ${consecutiveErrors}回 — クールダウン中...`);
                    consecutiveErrors = 0;
                    return;
                }
                await scanAll();
                consecutiveErrors = 0;
            } catch (err) {
                consecutiveErrors++;
                console.error(`❌ スキャンエラー (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
            }
        }, SCAN_INTERVAL_MS);
    }
}

main().catch(err => {
    console.error('❌ 致命的エラー:', err);
});
