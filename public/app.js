/**
 * Price Arbitrage — フロントエンドアプリケーション
 *
 * 検索UI、API呼び出し、結果表示を管理する。
 * サーバーAPIが利用可能な場合はサーバー経由、
 * 利用不可の場合はフロントエンドから直接楽天APIを呼ぶ。
 */

// ============================================================
//  楽天API設定（フロントエンド直接呼び出し用）
// ============================================================
const RAKUTEN_CONFIG = {
    appId: '4e0adb51-1f60-4d90-bc4e-208e0f6a538e',
    accessKey: 'pk_WyrXzWk3S2eGqEE6QUWU1tonG0weFUwjrQcH575NPw8',
    affiliateId: '51e3d606.edb6a336.51e3d607.848a4563',
    apiBase: 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601',
};

// ============================================================
//  eBay Cloudflare Worker プロキシ設定
// ============================================================
// デプロイ後にWorkerのURLを設定してください
// 例: 'https://ebay-proxy.your-account.workers.dev'
const EBAY_WORKER_URL = ''; // ← ここにWorker URLを設定

// Worker経由でリアルeBayデータを取得できるかのフラグ
let ebayWorkerAvailable = false;

// 為替レートキャッシュ
let cachedRates = { usdToJpy: 149.0 };

// サーバーが利用可能かどうかのフラグ
let serverAvailable = null;

// ============================================================
//  DOM要素の取得
// ============================================================
const $ = id => document.getElementById(id);

const searchForm = $('searchForm');
const searchInput = $('searchInput');
const searchBtn = $('searchBtn');
const presetsContainer = $('presets');
const loading = $('loading');
const errorBanner = $('errorBanner');
const errorText = $('errorText');
const resultsSection = $('resultsSection');
const summaryCards = $('summaryCards');
const ebayTopList = $('ebayTopList');
const opportunitiesList = $('opportunitiesList');
const introSection = $('introSection');
const modeBadge = $('modeBadge');
const rateDisplay = $('rateDisplay');

// ============================================================
//  初期化
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    // サーバー利用可否を判定
    await detectServer();

    // eBay Worker検出
    await detectEbayWorker();

    // プリセット読み込み
    await loadPresets();

    // 為替レート取得
    await loadRates();

    // ステータス取得
    await loadStatus();
});

// ============================================================
//  イベントリスナー
// ============================================================

searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyword = searchInput.value.trim();
    if (keyword) {
        await performSearch(keyword);
    }
});

// ============================================================
//  サーバー検出
// ============================================================

/**
 * サーバーが利用可能か検出する
 */
async function detectServer() {
    try {
        const res = await fetch('/api/status', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            serverAvailable = true;
            console.log('✅ サーバー検出: ローカルサーバーモード');
        } else {
            serverAvailable = false;
        }
    } catch {
        serverAvailable = false;
        console.log('📡 サーバー未検出: スタンドアロンモード（楽天API直接呼び出し）');
    }
}

// ============================================================
//  API呼び出し
// ============================================================

// プリセットデータ（サーバーなしでも使えるよう埋め込み）
const PRESETS = [
    {
        label: '🏪 無印良品（MUJI）',
        keyword: 'MUJI japan',
        ebayKeyword: 'MUJI japan',
        rakutenKeyword: '無印良品',
        description: '無印良品の商品 — 海外で人気のアロマ・文具・生活雑貨',
    },
    {
        label: '📚 マンガ初版',
        keyword: 'manga first edition japanese',
        ebayKeyword: 'manga first edition japanese',
        rakutenKeyword: 'マンガ 初版',
        description: '日本語マンガの初版本 — コレクター需要が高い',
    },
    {
        label: '🎮 レトロゲーム',
        keyword: 'retro game japan nintendo',
        ebayKeyword: 'retro game japan nintendo',
        rakutenKeyword: 'レトロゲーム ファミコン',
        description: 'レトロゲームソフト — 海外コレクターに人気',
    },
    {
        label: '📸 日本製カメラ',
        keyword: 'japan camera vintage lens',
        ebayKeyword: 'japan vintage camera lens nikon',
        rakutenKeyword: 'ビンテージ カメラ レンズ',
        description: 'ビンテージカメラ・レンズ — ニコン、キヤノン、オリンパス',
    },
    {
        label: '🍵 日本製食器',
        keyword: 'japanese pottery ceramic',
        ebayKeyword: 'japanese pottery ceramic handmade',
        rakutenKeyword: '和食器 陶器 手作り',
        description: '和食器・陶器 — 手作り陶磁器の海外需要',
    },
    {
        label: '🎌 アニメフィギュア',
        keyword: 'anime figure japan',
        ebayKeyword: 'anime figure japan limited',
        rakutenKeyword: 'アニメ フィギュア 限定',
        description: 'アニメフィギュア・限定グッズ',
    },
];

/**
 * プリセット一覧を表示する
 */
async function loadPresets() {
    let presets = PRESETS;

    // サーバーがあればサーバーから取得を試みる
    if (serverAvailable) {
        try {
            const res = await fetch('/api/presets');
            const data = await res.json();
            presets = data.presets || PRESETS;
        } catch {
            // フォールバック: 埋め込みプリセットを使用
        }
    }

    presetsContainer.innerHTML = presets.map(preset =>
        `<button class="preset-btn" data-keyword="${escapeHtml(preset.keyword)}" data-ebay="${escapeHtml(preset.ebayKeyword || preset.keyword)}" data-rakuten="${escapeHtml(preset.rakutenKeyword || preset.keyword)}" title="${escapeHtml(preset.description)}">
            ${preset.label}
        </button>`
    ).join('');

    // プリセットボタンのクリックイベント
    presetsContainer.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const keyword = btn.dataset.keyword;
            const ebayKw = btn.dataset.ebay;
            const rakutenKw = btn.dataset.rakuten;
            searchInput.value = keyword;
            performSearch(keyword, ebayKw, rakutenKw);
        });
    });
}

/**
 * 為替レートを取得して表示する
 */
async function loadRates() {
    // まずサーバーから試みる
    if (serverAvailable) {
        try {
            const res = await fetch('/api/rates');
            const data = await res.json();
            cachedRates = data;
            rateDisplay.textContent = `💱 1 USD = ¥${data.usdToJpy.toFixed(1)}`;
            return;
        } catch {
            // フォールバック
        }
    }

    // フォールバック: 外部為替APIから取得
    try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await res.json();
        cachedRates.usdToJpy = data.rates?.JPY || 149.0;
        rateDisplay.textContent = `💱 1 USD = ¥${cachedRates.usdToJpy.toFixed(1)}`;
    } catch {
        rateDisplay.textContent = `💱 1 USD = ¥${cachedRates.usdToJpy.toFixed(1)}（参考）`;
    }
}

/**
 * サーバーステータスを取得してモードバッジを更新
 */
async function loadStatus() {
    if (!serverAvailable) {
        modeBadge.textContent = 'STANDALONE';
        modeBadge.className = 'badge live';
        return;
    }

    try {
        const res = await fetch('/api/status');
        const data = await res.json();

        if (data.mode === 'demo') {
            modeBadge.textContent = 'DEMO';
            modeBadge.className = 'badge';
        } else if (data.mode === 'api') {
            modeBadge.textContent = 'API';
            modeBadge.className = 'badge live';
        } else if (data.mode === 'hybrid') {
            modeBadge.textContent = 'HYBRID';
            modeBadge.className = 'badge live';
        } else {
            modeBadge.textContent = 'LIVE';
            modeBadge.className = 'badge live';
        }
    } catch {
        // エラー時はデフォルト
    }
}

// ============================================================
//  楽天API 直接呼び出し（ブラウザ専用）
// ============================================================

/**
 * フロントエンドから直接楽天APIを呼ぶ
 * @param {string} keyword - 検索キーワード
 * @param {number} [hits=20] - 取得件数
 * @returns {Promise<Array>} 検索結果
 */
async function searchRakutenDirect(keyword, hits = 20) {
    const params = new URLSearchParams({
        applicationId: RAKUTEN_CONFIG.appId,
        accessKey: RAKUTEN_CONFIG.accessKey,
        affiliateId: RAKUTEN_CONFIG.affiliateId,
        keyword: keyword,
        hits: String(Math.min(hits, 30)),
        format: 'json',
    });

    const url = `${RAKUTEN_CONFIG.apiBase}?${params}`;
    console.log(`🔍 楽天API直接呼び出し: "${keyword}"`);

    const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`楽天API エラー (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const items = data.Items || [];

    console.log(`  → 楽天: ${items.length}件取得`);

    return items.map(entry => {
        const item = entry.Item || entry;
        return {
            title: item.itemName || '',
            price: item.itemPrice || 0,
            currency: 'JPY',
            imageUrl: item.mediumImageUrls?.[0]?.imageUrl || item.smallImageUrls?.[0]?.imageUrl || '',
            url: item.itemUrl || item.affiliateUrl || '',
            shopName: item.shopName || '',
            reviewCount: item.reviewCount || 0,
            reviewAverage: item.reviewAverage || 0,
        };
    });
}

// ============================================================
//  eBay Worker プロキシ呼び出し
// ============================================================

/**
 * Cloudflare Worker経由でeBay Browse APIを検索する
 * @param {string} keyword - 検索キーワード
 * @param {number} [limit=20] - 取得件数
 * @returns {Promise<Array>} 検索結果
 */
async function searchEbayViaWorker(keyword, limit = 20) {
    if (!EBAY_WORKER_URL) throw new Error('Worker URL未設定');

    const params = new URLSearchParams({ q: keyword, limit: String(limit) });
    const url = `${EBAY_WORKER_URL}/search?${params}`;

    console.log(`🔍 eBay Worker呼び出し: "${keyword}"`);

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `eBay Worker エラー (${res.status})`);
    }

    const data = await res.json();
    console.log(`  → eBay: ${data.count || 0}件取得（Worker経由）`);

    return (data.items || []).map(item => ({
        ...item,
        priceJpy: Math.round((item.price || 0) * cachedRates.usdToJpy),
        priceOriginal: `USD ${(item.price || 0).toFixed(2)}`,
    }));
}

/**
 * Worker起動チェック（初期化時に呼ぶ）
 */
async function detectEbayWorker() {
    if (!EBAY_WORKER_URL) {
        console.log('📊 eBay Worker URL未設定 → 参考価格データモード');
        ebayWorkerAvailable = false;
        return;
    }
    try {
        const res = await fetch(`${EBAY_WORKER_URL}/status`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            const data = await res.json();
            ebayWorkerAvailable = data.hasEbayKeys === true;
            console.log(`✅ eBay Worker検出: ${ebayWorkerAvailable ? 'APIキー設定済み' : 'APIキー未設定'}`);
        }
    } catch {
        console.log('⚠️ eBay Worker接続失敗 → 参考価格データモード');
        ebayWorkerAvailable = false;
    }
}

// ============================================================
//  eBay参考価格データ（スタンドアロンモード用・フォールバック）
// ============================================================

const EBAY_REFERENCE = {
    muji: {
        label: 'MUJI Products', multiplier: 2.5,
        keywords: ['muji', '無印良品', '無印'],
        examples: [
            { name: 'MUJI Aroma Diffuser', priceUsd: 32.50 },
            { name: 'MUJI Gel Ink Pen Set', priceUsd: 29.99 },
            { name: 'MUJI Essential Oil Set', priceUsd: 47.22 },
            { name: 'MUJI Stationery Set', priceUsd: 35.00 },
            { name: 'MUJI Skincare Product', priceUsd: 25.00 },
        ],
    },
    manga: {
        label: 'Manga First Editions', multiplier: 5.0,
        keywords: ['manga', 'マンガ', '漫画', '初版', 'first edition', 'one piece', 'dragon ball'],
        examples: [
            { name: 'ONE PIECE Vol.1 1st Print', priceUsd: 2980.00 },
            { name: 'NARUTO Vol.1 1st Print', priceUsd: 880.00 },
            { name: 'DRAGON BALL Vol.1 1st Print', priceUsd: 500.00 },
            { name: 'Generic Manga Volume', priceUsd: 25.00 },
        ],
    },
    retrogame: {
        label: 'Retro Games', multiplier: 3.0,
        keywords: ['retro game', 'レトロゲーム', 'ファミコン', 'famicom', 'nintendo', 'snes'],
        examples: [
            { name: 'Super Famicom Console CIB', priceUsd: 150.00 },
            { name: 'Famicom Game CIB', priceUsd: 45.00 },
            { name: 'Game Boy Color Console', priceUsd: 80.00 },
        ],
    },
    camera: {
        label: 'Vintage Cameras', multiplier: 2.0,
        keywords: ['camera', 'カメラ', 'lens', 'レンズ', 'nikon', 'canon', 'olympus'],
        examples: [
            { name: 'Nikon FM2 Body', priceUsd: 250.00 },
            { name: 'Nikkor 50mm f/1.4', priceUsd: 180.00 },
            { name: 'Canon AE-1 Program', priceUsd: 200.00 },
        ],
    },
    pottery: {
        label: 'Japanese Pottery', multiplier: 2.5,
        keywords: ['pottery', '陶器', '食器', 'ceramic', '和食器'],
        examples: [
            { name: 'Hasami Ware Set', priceUsd: 60.00 },
            { name: 'Arita Porcelain Plate', priceUsd: 45.00 },
        ],
    },
    anime: {
        label: 'Anime Figures', multiplier: 1.8,
        keywords: ['anime', 'figure', 'フィギュア', 'アニメ', '限定'],
        examples: [
            { name: 'S.H.Figuarts Figure', priceUsd: 80.00 },
            { name: 'Nendoroid Figure', priceUsd: 55.00 },
            { name: 'Prize Figure', priceUsd: 30.00 },
        ],
    },
    default: {
        label: 'General Japanese Products', multiplier: 2.0,
        keywords: [],
        examples: [
            { name: 'Japanese Product', priceUsd: 30.00 },
        ],
    },
};

/**
 * キーワードからカテゴリを推定する
 */
function detectCategory(keyword) {
    const lower = keyword.toLowerCase();
    for (const [key, cat] of Object.entries(EBAY_REFERENCE)) {
        if (key === 'default') continue;
        if (cat.keywords.some(kw => lower.includes(kw.toLowerCase()))) return cat;
    }
    return EBAY_REFERENCE.default;
}

/**
 * eBay参考アイテムを生成する
 */
function getEbayReferenceItems(keyword) {
    const cat = detectCategory(keyword);
    return cat.examples.map(ex => ({
        title: ex.name,
        price: ex.priceUsd,
        currency: 'USD',
        priceJpy: Math.round(ex.priceUsd * cachedRates.usdToJpy),
        priceOriginal: `USD ${ex.priceUsd}`,
        imageUrl: '',
        url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ex.name)}`,
        condition: '',
        location: '',
    }));
}

/**
 * スタンドアロンモードで価格比較を実行する
 * @param {string} keyword - 検索キーワード
 * @param {string} ebayKw - eBay用キーワード
 * @param {string} rakutenKw - 楽天用キーワード
 * @returns {Promise<object>} 比較結果
 */
async function standaloneSearch(keyword, ebayKw, rakutenKw) {
    // 楽天データ取得（フロントエンド直接）
    let rakutenItems = [];
    try {
        rakutenItems = await searchRakutenDirect(rakutenKw || keyword);
    } catch (err) {
        console.error('楽天API エラー:', err.message);
    }

    // eBayデータ取得: Worker → 参考データのフォールバック
    let ebayItems = [];
    let ebaySource = 'reference';
    if (ebayWorkerAvailable) {
        try {
            ebayItems = await searchEbayViaWorker(ebayKw || keyword);
            ebaySource = 'api';
        } catch (err) {
            console.warn('eBay Worker エラー、参考データにフォールバック:', err.message);
            ebayItems = getEbayReferenceItems(ebayKw || keyword);
        }
    } else {
        ebayItems = getEbayReferenceItems(ebayKw || keyword);
    }

    if (!ebayItems.length && !rakutenItems.length) {
        return {
            keyword,
            searchedAt: new Date().toISOString(),
            mode: 'standalone',
            warning: '検索結果が取得できませんでした。キーワードを変えてお試しください。',
            ebayStats: { count: 0 },
            ebayTopItems: [],
            opportunities: [],
            summary: { totalOpportunities: 0, profitableCount: 0, bestProfit: 0, avgProfit: 0 },
        };
    }

    // 手数料定数
    const EBAY_FEE_RATE = 0.13;
    const PAYMENT_FEE_RATE = 0.03;
    const SHIPPING_COST = 2000;

    // eBay価格統計（JPY換算）
    const ebayPricesJpy = ebayItems.map(i => i.priceJpy || Math.round(i.price * cachedRates.usdToJpy)).filter(p => p > 0).sort((a, b) => b - a);
    const ebayStats = {
        count: ebayPricesJpy.length,
        max: ebayPricesJpy[0] || 0,
        min: ebayPricesJpy[ebayPricesJpy.length - 1] || 0,
        avg: ebayPricesJpy.length > 0 ? Math.round(ebayPricesJpy.reduce((a, b) => a + b, 0) / ebayPricesJpy.length) : 0,
        median: ebayPricesJpy.length > 0 ? ebayPricesJpy[Math.floor(ebayPricesJpy.length / 2)] : 0,
    };

    // 利益計算
    const opportunities = rakutenItems
        .filter(item => item.price > 0)
        .map(item => {
            const buyPrice = item.price;
            const sellPrice = ebayStats.median || ebayStats.avg;
            const ebayFee = Math.round(sellPrice * EBAY_FEE_RATE);
            const paymentFee = Math.round(sellPrice * PAYMENT_FEE_RATE);
            const netProfit = sellPrice - buyPrice - ebayFee - paymentFee - SHIPPING_COST;
            const roi = buyPrice > 0 ? Math.round(((sellPrice - buyPrice) / buyPrice) * 100) : 0;

            return {
                domesticTitle: item.title,
                domesticPrice: buyPrice,
                domesticUrl: item.url,
                domesticImageUrl: item.imageUrl,
                domesticShop: item.shopName,
                ebayAvgPrice: ebayStats.avg,
                ebayMedianPrice: ebayStats.median,
                ebayListingCount: ebayStats.count,
                estimatedSellPrice: sellPrice,
                ebayFee,
                paymentFee,
                shippingCost: SHIPPING_COST,
                netProfit,
                roi,
            };
        })
        .sort((a, b) => b.netProfit - a.netProfit);

    // eBayトップ商品
    const ebayTopItems = ebayItems
        .map(item => ({ ...item, priceJpy: item.priceJpy || Math.round(item.price * cachedRates.usdToJpy) }))
        .sort((a, b) => b.priceJpy - a.priceJpy)
        .slice(0, 10);

    return {
        keyword,
        searchedAt: new Date().toISOString(),
        mode: 'standalone',
        ebaySource: ebaySource,
        dataSources: {
            ebay: ebaySource === 'api'
                ? `${ebayItems.length}件（eBay API）`
                : `参考価格データ（${detectCategory(ebayKw || keyword).label}）`,
            rakuten: `${rakutenItems.length}件（API直接）`,
        },
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
 * 検索を実行する
 * @param {string} keyword - 検索キーワード
 * @param {string} [ebayKw] - eBay用キーワード（省略時はkeywordを使用）
 * @param {string} [rakutenKw] - 楽天用キーワード（省略時はkeywordを使用）
 */
async function performSearch(keyword, ebayKw = '', rakutenKw = '') {
    // UI状態リセット
    showLoading(true);
    hideError();
    hideResults();
    introSection.style.display = 'none';
    searchBtn.disabled = true;

    try {
        let data;

        // サーバーが利用可能ならサーバー経由
        if (serverAvailable) {
            let url = `/api/search?q=${encodeURIComponent(keyword)}`;
            if (ebayKw) url += `&ebayKeyword=${encodeURIComponent(ebayKw)}`;
            if (rakutenKw) url += `&rakutenKeyword=${encodeURIComponent(rakutenKw)}`;

            const res = await fetch(url);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `サーバーエラー (${res.status})`);
            }

            data = await res.json();
        } else {
            // スタンドアロンモード: フロントエンド直接
            data = await standaloneSearch(keyword, ebayKw, rakutenKw);
        }

        if (data.error) {
            showError(data.error);
            return;
        }

        renderResults(data);
    } catch (err) {
        // サーバーモードで失敗した場合、スタンドアロンにフォールバック
        if (serverAvailable) {
            console.warn('サーバーAPI失敗、スタンドアロンモードにフォールバック:', err.message);
            try {
                const data = await standaloneSearch(keyword, ebayKw, rakutenKw);
                renderResults(data);
                return;
            } catch (fallbackErr) {
                showError(fallbackErr.message);
                return;
            }
        }
        showError(err.message);
    } finally {
        showLoading(false);
        searchBtn.disabled = false;
    }
}

// ============================================================
//  結果表示
// ============================================================

/**
 * 検索結果を画面に表示する
 * @param {object} data - APIレスポンス
 */
function renderResults(data) {
    // モードバナー
    let html = '';
    if (data.isDemo) {
        html += `<div class="demo-banner">🎭 デモモード — サンプルデータを表示しています。</div>`;
    } else {
        const sources = data.dataSources
            ? `eBay: ${data.dataSources.ebay} / 楽天: ${data.dataSources.rakuten}`
            : '';

        // eBayソースに応じてバナー色分け
        let bannerColor, icon, label;
        if (data.ebaySource === 'api') {
            bannerColor = 'background:rgba(16,185,129,0.12);color:#10b981;border-color:rgba(16,185,129,0.3);';
            icon = '🔑';
            label = 'APIモード — eBay公式APIでリアルデータ取得';
        } else if (data.ebaySource === 'scrape') {
            bannerColor = 'background:rgba(16,185,129,0.12);color:#10b981;border-color:rgba(16,185,129,0.3);';
            icon = '🌐';
            label = 'リアルデータ — HTTPスクレイピングで取得';
        } else {
            bannerColor = 'background:rgba(139,92,246,0.12);color:#a78bfa;border-color:rgba(139,92,246,0.3);';
            icon = '📊';
            label = '推定データ — 楽天（実データ）+ eBay（参考価格）';
        }
        html += `<div class="demo-banner" style="${bannerColor}">${icon} ${label} ${sources ? `(${sources})` : ''}</div>`;
    }
    if (data.warning) {
        html += `<div class="demo-banner" style="background:rgba(245,158,11,0.12);color:#f59e0b;border-color:rgba(245,158,11,0.3);">⚠️ ${escapeHtml(data.warning)}</div>`;
    }

    // サマリーカード
    const summary = data.summary || {};
    const stats = data.ebayStats || {};

    summaryCards.innerHTML = html + `
        <div class="summary-card neutral">
            <div class="card-icon">📊</div>
            <div class="card-value">${stats.count || 0}</div>
            <div class="card-label">eBay出品数</div>
        </div>
        <div class="summary-card ${stats.median > 0 ? 'profit' : 'neutral'}">
            <div class="card-icon">💰</div>
            <div class="card-value">${formatJpy(stats.median || stats.avg || 0)}</div>
            <div class="card-label">eBay中央値</div>
        </div>
        <div class="summary-card ${summary.profitableCount > 0 ? 'profit' : 'neutral'}">
            <div class="card-icon">🎯</div>
            <div class="card-value">${summary.profitableCount || 0}<span style="font-size:14px;">件</span></div>
            <div class="card-label">利益見込み</div>
        </div>
        <div class="summary-card ${(summary.bestProfit || 0) > 0 ? 'profit' : 'loss'}">
            <div class="card-icon">🏆</div>
            <div class="card-value">${formatJpy(summary.bestProfit || 0)}</div>
            <div class="card-label">最大利益</div>
        </div>
    `;

    // eBayトップ商品
    const topItems = data.ebayTopItems || [];
    if (topItems.length > 0) {
        ebayTopList.innerHTML = topItems.map(item => `
            <a class="ebay-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
                ${item.imageUrl
                    ? `<img class="ebay-item-img" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">`
                    : `<div class="ebay-item-img" style="display:flex;align-items:center;justify-content:center;font-size:24px;">📦</div>`
                }
                <div class="ebay-item-info">
                    <div class="ebay-item-title">${escapeHtml(item.title)}</div>
                    <div class="ebay-item-price">${formatJpy(item.priceJpy)}</div>
                    <div class="ebay-item-meta">${escapeHtml(item.priceOriginal || '')} ${item.condition ? `• ${item.condition}` : ''} ${item.location ? `• 📍${item.location}` : ''}</div>
                </div>
            </a>
        `).join('');
    } else {
        ebayTopList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">eBay出品が見つかりません</div></div>`;
    }

    // 利益機会リスト
    const opportunities = data.opportunities || [];
    if (opportunities.length > 0) {
        opportunitiesList.innerHTML = opportunities.map(opp => {
            const isProfitable = opp.netProfit > 0;
            // 各商品のタイトルからeBay検索用キーワードを生成
            const itemEbayKeyword = extractEbayKeyword(opp.domesticTitle);
            return `
                <div class="opportunity-card ${isProfitable ? 'profitable' : 'not-profitable'}">
                    <div class="opp-header">
                        <div class="opp-title">${escapeHtml(opp.domesticTitle)}</div>
                        <div class="opp-profit-badge ${isProfitable ? 'positive' : 'negative'}">
                            ${isProfitable ? '+' : ''}${formatJpy(opp.netProfit)}
                        </div>
                    </div>
                    <div class="opp-details">
                        <div class="opp-detail">
                            <div class="opp-detail-label">🏷️ 国内価格</div>
                            <div class="opp-detail-value">${formatJpy(opp.domesticPrice)}</div>
                        </div>
                        <div class="opp-detail">
                            <div class="opp-detail-label">💰 eBay想定売価</div>
                            <div class="opp-detail-value">${formatJpy(opp.estimatedSellPrice)}</div>
                        </div>
                        <div class="opp-detail">
                            <div class="opp-detail-label">📉 手数料計</div>
                            <div class="opp-detail-value text-danger">${formatJpy(opp.ebayFee + opp.paymentFee)}</div>
                        </div>
                        <div class="opp-detail">
                            <div class="opp-detail-label">📦 送料</div>
                            <div class="opp-detail-value">${formatJpy(opp.shippingCost)}</div>
                        </div>
                        <div class="opp-detail">
                            <div class="opp-detail-label">📈 ROI</div>
                            <div class="opp-detail-value ${opp.roi > 0 ? 'text-success' : 'text-danger'}">${opp.roi}%</div>
                        </div>
                        <div class="opp-detail">
                            <div class="opp-detail-label">📊 eBay出品数</div>
                            <div class="opp-detail-value">${opp.ebayListingCount}件</div>
                        </div>
                    </div>
                    </div>
                    <div class="opp-footer">
                        <div class="opp-ebay-kw">🔎 eBay検索: <code>${escapeHtml(itemEbayKeyword)}</code></div>
                        <div class="opp-links">
                            ${opp.domesticUrl ? `<a class="opp-link buy-link" href="${escapeHtml(opp.domesticUrl)}" target="_blank" rel="noopener">🛒 楽天で購入 →</a>` : ''}
                            <a class="opp-link sold-link" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(itemEbayKeyword)}&LH_Sold=1&LH_Complete=1&_sop=13" target="_blank" rel="noopener">✅ eBay落札実績 →</a>
                            <a class="opp-link ebay-link" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(itemEbayKeyword)}&_sop=13" target="_blank" rel="noopener">🔍 eBay出品中 →</a>
                        </div>
                        <div class="opp-hint">💡 落札実績で「いつ・いくらで売れたか」を確認 → 直近に高値で売れていれば仕入れ判断OK</div>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        opportunitiesList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">利益が見込める商品が見つかりません</div></div>`;
    }

    resultsSection.style.display = 'block';
}

// ============================================================
//  UI ヘルパー
// ============================================================

function showLoading(show) {
    loading.style.display = show ? 'block' : 'none';
}

function showError(message) {
    errorText.textContent = message;
    errorBanner.style.display = 'flex';
}

function hideError() {
    errorBanner.style.display = 'none';
}

function hideResults() {
    resultsSection.style.display = 'none';
}

/**
 * 金額をフォーマットする
 * @param {number} amount
 * @returns {string}
 */
function formatJpy(amount) {
    if (amount === 0) return '¥0';
    const absAmount = Math.abs(Math.round(amount));
    const formatted = absAmount.toLocaleString('ja-JP');
    return amount < 0 ? `-¥${formatted}` : `¥${formatted}`;
}

/**
 * HTMLエスケープ
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
//  eBayキーワード抽出
// ============================================================

// 日本語ブランド名→英語マッピング
const BRAND_MAP = {
    '無印良品': 'MUJI', '無印': 'MUJI',
    'ユニクロ': 'UNIQLO',
    'ソニー': 'SONY', 'パナソニック': 'Panasonic',
    'ニコン': 'Nikon', 'キヤノン': 'Canon', 'キャノン': 'Canon',
    'オリンパス': 'Olympus', 'フジフイルム': 'Fujifilm',
    'トヨタ': 'Toyota', 'ホンダ': 'Honda',
    'バンダイ': 'Bandai', 'タカラトミー': 'Takara Tomy',
    '任天堂': 'Nintendo', 'セガ': 'SEGA', 'カプコン': 'Capcom',
    'ポケモン': 'Pokemon', 'ポケットモンスター': 'Pokemon',
    'ドラゴンボール': 'Dragon Ball', 'ワンピース': 'One Piece',
    'ナルト': 'Naruto', '鬼滅の刃': 'Demon Slayer',
    '進撃の巨人': 'Attack on Titan', '呪術廻戦': 'Jujutsu Kaisen',
    'スタジオジブリ': 'Studio Ghibli', 'ジブリ': 'Ghibli',
    'サンリオ': 'Sanrio', 'ハローキティ': 'Hello Kitty',
    'カシオ': 'Casio', 'セイコー': 'Seiko', 'シチズン': 'Citizen',
    'ダイソン': 'Dyson', 'レゴ': 'LEGO',
    'アロマ': 'aroma', 'ディフューザー': 'diffuser',
    'フィギュア': 'figure', '限定': 'limited edition',
    'ぬいぐるみ': 'plush', 'ステーショナリー': 'stationery',
    '文房具': 'stationery', '万年筆': 'fountain pen',
    'ボールペン': 'ballpoint pen',
    '陶器': 'pottery', '磁器': 'porcelain', '食器': 'tableware',
    '急須': 'teapot', '茶碗': 'tea bowl', '湯呑': 'tea cup',
    '着物': 'kimono', '浴衣': 'yukata',
    '包丁': 'knife', '抹茶': 'matcha',
};

/**
 * 楽天の日本語タイトルからeBay検索キーワードを抽出する
 * @param {string} title - 楽天商品タイトル
 * @returns {string} eBay検索用の英語キーワード
 */
function extractEbayKeyword(title) {
    if (!title) return 'japanese product';

    const parts = [];

    // 1. 英字・数字の部分を抽出（ブランド名・型番など）
    const englishParts = title.match(/[A-Za-z][A-Za-z0-9./-]{1,}/g) || [];
    // ノイズワードを除外
    const noiseWords = new Set(['cm', 'mm', 'ml', 'kg', 'px', 'the', 'and', 'for', 'with', 'http', 'https', 'www', 'jpg', 'png', 'html']);
    for (const part of englishParts) {
        if (!noiseWords.has(part.toLowerCase()) && part.length > 1) {
            parts.push(part);
        }
    }

    // 2. 日本語ブランド名を英語に変換
    for (const [jp, en] of Object.entries(BRAND_MAP)) {
        if (title.includes(jp) && !parts.some(p => p.toLowerCase() === en.toLowerCase())) {
            parts.push(en);
        }
    }

    // 3. 結果が空なら「japan」+カテゴリで検索
    if (parts.length === 0) {
        // タイトルの最初の数文字をそのまま使う（日本語でもeBayで検索可能）
        const shortTitle = title.replace(/【.*?】/g, '').replace(/\[.*?\]/g, '').trim().substring(0, 30);
        return `japan ${shortTitle}`;
    }

    // 重複除去して最大6語まで
    const unique = [...new Set(parts)];
    return unique.slice(0, 6).join(' ');
}
