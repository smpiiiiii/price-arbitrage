/**
 * Price Arbitrage サーバー
 *
 * eBayと楽天の価格差を調べるWebツールのバックエンド。
 *
 * 3つのモード:
 *   1. APIモード: eBay Browse API + 楽天API（APIキー設定時）
 *   2. スクレイプモード: HTTP fetch + Cheerio（デフォルト・APIキー不要）
 *   3. デモモード: サンプルデータ（DEMO_MODE=true時）
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { searchEbay } from './api/ebay.js';
import { searchRakuten } from './api/rakuten.js';
import { scrapeEbay } from './api/ebay-scraper.js';
import { scrapeRakuten } from './api/rakuten-scraper.js';
import { getExchangeRates } from './api/exchange.js';
import { compareProducts } from './lib/comparator.js';
import { getEbayReferenceItems, detectCategory } from './lib/ebay-reference.js';
import { getDemoData } from './demo/sample-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// 設定
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID || '';
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY || '';
const RAKUTEN_AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID || '';
const FORCE_DEMO = process.env.DEMO_MODE === 'true';

// 各ソースの利用可否を個別判定
const hasEbayApi = EBAY_CLIENT_ID && EBAY_CLIENT_ID !== 'your_ebay_client_id';
const hasRakutenApi = RAKUTEN_APP_ID && RAKUTEN_APP_ID !== 'your_rakuten_app_id';

// モード判定（表示用ラベル）
// - api: eBay・楽天ともにAPI
// - hybrid: 片方API + 片方スクレイプ
// - scrape: 両方スクレイプ
// - demo: デモデータ
const mode = FORCE_DEMO ? 'demo'
    : (hasEbayApi && hasRakutenApi) ? 'api'
    : (hasEbayApi || hasRakutenApi) ? 'hybrid'
    : 'scrape';

// 静的ファイル配信
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// ============================================================
//  API エンドポイント
// ============================================================

/**
 * GET /api/search?q=keyword&ebayKeyword=xxx&rakutenKeyword=yyy
 * eBayと楽天の両方で検索し、価格差を比較する
 */
app.get('/api/search', async (req, res) => {
    const keyword = req.query.q?.trim();
    if (!keyword) {
        return res.status(400).json({ error: 'キーワードを指定してください（?q=keyword）' });
    }

    // eBayと楽天で別のキーワードを使えるようにする
    const ebayKeyword = req.query.ebayKeyword?.trim() || keyword;
    const rakutenKeyword = req.query.rakutenKeyword?.trim() || keyword;

    console.log(`\n🔍 検索リクエスト: "${keyword}" [モード: ${mode}]`);

    try {
        // ============================================================
        //  デモモード
        // ============================================================
        if (mode === 'demo') {
            const demoResult = getDemoData(keyword);
            demoResult.keyword = keyword;
            await new Promise(r => setTimeout(r, 500));
            return res.json(demoResult);
        }

        // ============================================================
        //  各ソース個別にAPI or スクレイプを選択
        // ============================================================
        let ebayItems = [];
        let rakutenItems = [];
        let ebaySource = '';
        let rakutenSource = '';

        // eBay: APIキーがあればAPI、なければHTTPスクレイプ
        const ebayPromise = hasEbayApi
            ? searchEbay(ebayKeyword, {
                clientId: EBAY_CLIENT_ID,
                clientSecret: EBAY_CLIENT_SECRET,
                limit: 20,
            }).then(items => { ebaySource = 'api'; return items; })
              .catch(err => {
                console.error('⚠️ eBay API エラー:', err.message);
                return [];
            })
            : scrapeEbay(ebayKeyword, { sold: false })
                .then(items => { ebaySource = items.length > 0 ? 'scrape' : ''; return items; })
                .catch(err => {
                    console.error('⚠️ eBay スクレイプエラー:', err.message);
                    return [];
                });

        // 楽天: APIキーがあればAPI、なければHTTPスクレイプ
        const rakutenPromise = hasRakutenApi
            ? searchRakuten(rakutenKeyword, {
                appId: RAKUTEN_APP_ID,
                accessKey: RAKUTEN_ACCESS_KEY,
                affiliateId: RAKUTEN_AFFILIATE_ID,
                referer: 'https://smpiiiiii.github.io/price-arbitrage/',
                hits: 20,
            }).then(items => { rakutenSource = 'api'; return items; })
              .catch(err => {
                console.error('⚠️ 楽天API エラー:', err.message);
                return [];
            })
            : scrapeRakuten(rakutenKeyword)
                .then(items => { rakutenSource = items.length > 0 ? 'scrape' : ''; return items; })
                .catch(err => {
                    console.error('⚠️ 楽天スクレイプエラー:', err.message);
                    return [];
                });

        [ebayItems, rakutenItems] = await Promise.all([ebayPromise, rakutenPromise]);

        // eBayが取得できなかった場合 → 参考価格データを使用
        if (!ebayItems.length && rakutenItems.length > 0) {
            console.log('📊 eBay参考価格データを使用します');
            ebayItems = await getEbayReferenceItems(ebayKeyword);
            ebaySource = 'reference';
        }

        // 結果なしの場合
        if (!ebayItems.length && !rakutenItems.length) {
            return res.json({
                keyword,
                searchedAt: new Date().toISOString(),
                mode,
                warning: 'eBay・楽天ともに検索結果が取得できませんでした。' +
                    (!hasEbayApi ? ' eBay APIキーを設定すると安定して取得できます。' : '') +
                    ' キーワードを変えてお試しください。',
                ebayStats: { count: 0 },
                ebayTopItems: [],
                opportunities: [],
                summary: { totalOpportunities: 0, profitableCount: 0, bestProfit: 0, avgProfit: 0 },
            });
        }

        const result = await compareProducts(ebayItems, rakutenItems);
        result.keyword = keyword;
        result.mode = mode;
        result.ebaySource = ebaySource;

        // データソース情報（フロントエンドでの表示用）
        const sourceLabel = (type, count) => {
            if (type === 'api') return `${count}件（API）`;
            if (type === 'scrape') return `${count}件（スクレイプ）`;
            if (type === 'reference') return `参考価格データ（${detectCategory(ebayKeyword).label}）`;
            return '取得失敗';
        };
        result.dataSources = {
            ebay: sourceLabel(ebaySource, ebayItems.length),
            rakuten: sourceLabel(rakutenSource, rakutenItems.length),
        };

        res.json(result);
    } catch (err) {
        console.error('❌ 検索エラー:', err);
        res.status(500).json({ error: `検索中にエラーが発生しました: ${err.message}` });
    }
});

/**
 * GET /api/presets
 * プリセット検索キーワード一覧
 * eBayと楽天で別のキーワードを設定可能
 */
app.get('/api/presets', (req, res) => {
    res.json({
        presets: [
            {
                label: '🏪 無印良品（MUJI）',
                keyword: 'MUJI japan',
                ebayKeyword: 'MUJI japan',
                rakutenKeyword: '無印良品',
                emoji: '🏪',
                description: '無印良品の商品 — 海外で人気のアロマ・文具・生活雑貨',
            },
            {
                label: '📚 マンガ初版',
                keyword: 'manga first edition japanese',
                ebayKeyword: 'manga first edition japanese',
                rakutenKeyword: 'マンガ 初版',
                emoji: '📚',
                description: '日本語マンガの初版本 — コレクター需要が高い',
            },
            {
                label: '🎮 レトロゲーム',
                keyword: 'retro game japan nintendo',
                ebayKeyword: 'retro game japan nintendo',
                rakutenKeyword: 'レトロゲーム ファミコン',
                emoji: '🎮',
                description: 'レトロゲームソフト — 海外コレクターに人気',
            },
            {
                label: '📸 日本製カメラ',
                keyword: 'japan camera vintage lens',
                ebayKeyword: 'japan vintage camera lens nikon',
                rakutenKeyword: 'ビンテージ カメラ レンズ',
                emoji: '📸',
                description: 'ビンテージカメラ・レンズ — ニコン、キヤノン、オリンパス',
            },
            {
                label: '🍵 日本製食器',
                keyword: 'japanese pottery ceramic',
                ebayKeyword: 'japanese pottery ceramic handmade',
                rakutenKeyword: '和食器 陶器 手作り',
                emoji: '🍵',
                description: '和食器・陶器 — 手作り陶磁器の海外需要',
            },
            {
                label: '🎌 アニメフィギュア',
                keyword: 'anime figure japan',
                ebayKeyword: 'anime figure japan limited',
                rakutenKeyword: 'アニメ フィギュア 限定',
                emoji: '🎌',
                description: 'アニメフィギュア・限定グッズ',
            },
        ],
        mode,
    });
});

/**
 * GET /api/rates
 */
app.get('/api/rates', async (req, res) => {
    try {
        const rates = await getExchangeRates();
        res.json(rates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        mode,
        isDemoMode: mode === 'demo',
        hasEbayKey: hasEbayApi,
        hasRakutenKey: hasRakutenApi,
        sources: {
            ebay: hasEbayApi ? 'API' : 'スクレイプ',
            rakuten: hasRakutenApi ? 'API' : 'スクレイプ',
        },
        version: '1.2.0',
    });
});

// ============================================================
//  サーバー起動
// ============================================================

const modeLabels = {
    api: '🔑 APIモード（eBay + 楽天 公式API）',
    hybrid: '🔀 ハイブリッドモード（API + スクレイプ混在）',
    scrape: '🌐 スクレイプモード（HTTPスクレイピング・APIキー不要）',
    demo: '🎭 デモモード（サンプルデータ）',
};

app.listen(PORT, () => {
    console.log(`\n🚀 Price Arbitrage Server v1.1 起動!`);
    console.log(`   URL: http://localhost:${PORT}`);
    console.log(`   モード: ${modeLabels[mode]}`);
    if (mode === 'scrape') {
        console.log(`\n   ℹ️  APIキー不要でリアルデータを取得します`);
        console.log(`   ⚠️  サイトのボット検知により取得できない場合があります\n`);
    }
});
