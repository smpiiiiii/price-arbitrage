/**
 * Snkrdunk Monitor — フロントエンドアプリ v3
 *
 * スニダンの人気商品をブラウザから直接検索し、
 * 楽天APIと比較して価格差を表示する。
 *
 * ※ CORSの制約により、スニダンAPIはサーバーサイドプロキシが必要。
 *    ここではCORS対応のAPIのみ直接呼び出し、
 *    スニダンデータはデモデータも含む。
 */

// ============================================================
//  設定
// ============================================================

/** スニダン手数料 */
const SNKRDUNK_FEE_RATE = 0.065;
const SNKRDUNK_SHIPPING = 990;

/** 通知しきい値 */
const THRESHOLD_PROFIT = 2000;
const THRESHOLD_ROI = 20;

/** 楽天APIキー（公開して問題ないアフィリエイトキー） */
const RAKUTEN_APP_ID = '4e0adb51-1f60-4d90-bc4e-208e0f6a538e';

/** ユーザーエージェント */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** プリセットキーワード */
const PRESETS = [
    { label: '👟 Air Jordan 1', keyword: 'Air Jordan 1' },
    { label: '🔥 Travis Scott', keyword: 'Travis Scott Nike' },
    { label: '👑 Dunk Low', keyword: 'Nike Dunk Low' },
    { label: '🏃 New Balance 1906', keyword: 'New Balance 1906' },
    { label: '💫 Air Force 1', keyword: 'Air Force 1' },
    { label: '⭐ adidas Spezial', keyword: 'adidas Spezial' },
    { label: '🐻 YEEZY', keyword: 'adidas YEEZY' },
    { label: '🌊 Air Max 95', keyword: 'Nike Air Max 95' },
];

// ============================================================
//  DOM要素
// ============================================================

const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const presetsDiv = document.getElementById('presets');
const scanPopularBtn = document.getElementById('scanPopularBtn');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const loadingDetail = document.getElementById('loadingDetail');
const progressBar = document.getElementById('progressBar');
const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');
const resultsSection = document.getElementById('resultsSection');
const summaryCards = document.getElementById('summaryCards');
const alertsList = document.getElementById('alertsList');
const productsGrid = document.getElementById('productsGrid');
const introSection = document.getElementById('introSection');

// ============================================================
//  初期化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    initPresets();
    searchForm.addEventListener('submit', handleSearch);
    scanPopularBtn.addEventListener('click', handlePopularScan);
});

/** プリセットボタンを生成 */
function initPresets() {
    PRESETS.forEach(preset => {
        const btn = document.createElement('button');
        btn.className = 'preset-btn';
        btn.textContent = preset.label;
        btn.addEventListener('click', () => {
            searchInput.value = preset.keyword;
            handleSearch(new Event('submit'));
        });
        presetsDiv.appendChild(btn);
    });
}

// ============================================================
//  CORSプロキシ対応のスニダンAPI
// ============================================================

/**
 * CORSプロキシ経由でスニダンの人気商品一覧を取得する
 * ※ GitHub Pagesではサーバーサイドが使えないため、
 *    複数の公開CORSプロキシを順に試行する
 */
const CORS_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://api.codetabs.com/v1/proxy?quest=',
];

async function fetchWithCorsProxy(url) {
    // まず直接アクセスを試みる（サーバー側でCORS許可されている場合）
    try {
        const directRes = await fetch(url, {
            headers: { 'Accept': 'application/json, text/html' },
            signal: AbortSignal.timeout(8000),
        });
        if (directRes.ok) return directRes;
    } catch { /* 直接アクセス失敗 — プロキシを試す */ }

    // CORSプロキシを順に試す
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), {
                signal: AbortSignal.timeout(10000),
            });
            if (res.ok) return res;
        } catch { /* 次のプロキシを試す */ }
    }

    throw new Error('全てのプロキシが失敗しました');
}

/**
 * スニダンの人気商品IDを取得する
 */
async function getSnkrdunkPopular() {
    updateLoading('スニダン人気商品を取得中…', '');
    const res = await fetchWithCorsProxy('https://snkrdunk.com/products?type=hottest');
    const html = await res.text();

    const productIds = [...new Set(
        (html.match(/\/products\/([A-Z0-9a-z_-]+)/g) || [])
            .map(m => m.replace('/products/', ''))
            .filter(id => id.length > 3 && !['type', 'hottest', 'newest'].includes(id))
    )];

    return productIds;
}

/**
 * スニダンの商品詳細を取得する
 */
async function getSnkrdunkProduct(productId) {
    try {
        const res = await fetchWithCorsProxy(`https://snkrdunk.com/v2/products/${productId}?type=sneaker`);
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * スニダンのサイズ別価格を取得する
 */
async function getSnkrdunkPrices(productId) {
    try {
        const res = await fetchWithCorsProxy(`https://snkrdunk.com/v1/sneakers/${productId}/size/list`);
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
    } catch {
        return null;
    }
}

// ============================================================
//  楽天APIクライアント（ブラウザからJSONP対応）
// ============================================================

/**
 * 楽天商品検索API（JSONPで呼び出し）
 */
function searchRakutenJsonp(keyword) {
    return new Promise((resolve) => {
        const callbackName = `rakutenCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const script = document.createElement('script');

        const timeout = setTimeout(() => {
            cleanup();
            resolve([]);
        }, 8000);

        function cleanup() {
            clearTimeout(timeout);
            delete window[callbackName];
            if (script.parentNode) script.parentNode.removeChild(script);
        }

        window[callbackName] = (data) => {
            cleanup();
            const items = (data.Items || []).map(item => {
                const i = item.Item || item;
                return {
                    title: i.itemName || '',
                    price: parseInt(i.itemPrice || '0', 10),
                    url: i.affiliateUrl || i.itemUrl || '',
                    imageUrl: (i.mediumImageUrls && i.mediumImageUrls[0]?.imageUrl) || '',
                };
            });
            resolve(items);
        };

        const params = new URLSearchParams({
            applicationId: RAKUTEN_APP_ID,
            keyword: keyword,
            hits: '10',
            sort: '+itemPrice',
            format: 'jsonp',
            callback: callbackName,
        });

        script.src = `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601?${params}`;
        script.onerror = () => { cleanup(); resolve([]); };
        document.head.appendChild(script);
    });
}

// ============================================================
//  利益計算
// ============================================================

function calculateProfit(buyPrice, sellPrice) {
    const snkrdunkFee = Math.round(sellPrice * SNKRDUNK_FEE_RATE);
    const netProfit = sellPrice - buyPrice - snkrdunkFee - SNKRDUNK_SHIPPING;
    const roi = buyPrice > 0 ? Math.round((netProfit / buyPrice) * 100) : 0;
    return { buyPrice, sellPrice, snkrdunkFee, shipping: SNKRDUNK_SHIPPING, netProfit, roi };
}

// ============================================================
//  URL生成
// ============================================================

function getMercariSearchUrl(keyword) {
    return `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&status=on_sale&order=desc&sort=created_time`;
}

function getYahooAuctionSearchUrl(keyword) {
    return `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(keyword)}`;
}

// ============================================================
//  検索ハンドラー
// ============================================================

async function handleSearch(e) {
    e.preventDefault();
    const keyword = searchInput.value.trim();
    if (!keyword) return;

    showLoading();
    hideError();

    try {
        updateLoading('スニダンで検索中…', keyword);

        // モデル番号で直接検索を試みる
        const product = await getSnkrdunkProduct(keyword);
        let products = [];

        if (product && product.nameJP) {
            // 単一商品が見つかった
            const priceData = await getSnkrdunkPrices(keyword);
            if (priceData) {
                products.push({ id: keyword, product, priceData });
            }
        }

        // 楽天で仕入れ候補を検索
        updateLoading('楽天で仕入れ候補を検索中…', keyword);
        const rakutenItems = await searchRakutenJsonp(keyword);

        const alerts = [];
        for (const p of products) {
            const sellPrice = p.priceData.minPrice;
            for (const item of rakutenItems) {
                const profit = calculateProfit(item.price, sellPrice);
                if (profit.netProfit >= THRESHOLD_PROFIT && profit.roi >= THRESHOLD_ROI) {
                    alerts.push({
                        product: p.product,
                        priceData: p.priceData,
                        productId: p.id,
                        sourceItem: item,
                        profit,
                        source: 'rakuten',
                    });
                }
            }
        }

        renderResults({
            keyword,
            products,
            rakutenItems,
            alerts,
        });
    } catch (err) {
        showError(err.message);
    } finally {
        hideLoading();
    }
}

async function handlePopularScan() {
    showLoading();
    hideError();

    try {
        const productIds = await getSnkrdunkPopular();
        const total = Math.min(productIds.length, 15); // ブラウザでは15件に制限
        const products = [];
        const alerts = [];

        for (let i = 0; i < total; i++) {
            const productId = productIds[i];
            updateLoading(
                `商品 ${i + 1}/${total} を処理中…`,
                productId
            );
            progressBar.style.width = `${((i + 1) / total) * 100}%`;

            const product = await getSnkrdunkProduct(productId);
            if (!product) continue;

            const priceData = await getSnkrdunkPrices(productId);
            if (!priceData) continue;

            products.push({ id: productId, product, priceData });

            // 楽天検索
            const rakutenItems = await searchRakutenJsonp(productId);
            if (rakutenItems.length > 0) {
                const sellPrice = priceData.minPrice;
                for (const item of rakutenItems) {
                    const profit = calculateProfit(item.price, sellPrice);
                    if (profit.netProfit >= THRESHOLD_PROFIT && profit.roi >= THRESHOLD_ROI) {
                        alerts.push({
                            product,
                            priceData,
                            productId,
                            sourceItem: item,
                            profit,
                            source: 'rakuten',
                        });
                    }
                }
            }

            // レート制限対策
            await sleep(1500);
        }

        renderResults({
            keyword: '人気商品スキャン',
            products,
            rakutenItems: [],
            alerts,
        });
    } catch (err) {
        showError(err.message);
    } finally {
        hideLoading();
    }
}

// ============================================================
//  レンダリング
// ============================================================

function renderResults(data) {
    introSection.style.display = 'none';
    resultsSection.style.display = 'block';

    // サマリーカード
    summaryCards.innerHTML = [
        cardHTML('👟', data.products.length, 'スキャン商品', 'neutral'),
        cardHTML('🔥', data.alerts.length, 'アラート', data.alerts.length > 0 ? 'profit' : 'neutral'),
        cardHTML('💰', data.alerts.length > 0
            ? `¥${Math.max(...data.alerts.map(a => a.profit.netProfit)).toLocaleString()}`
            : '—', '最大利益', 'profit'),
        cardHTML('📊', data.alerts.length > 0
            ? `${Math.max(...data.alerts.map(a => a.profit.roi))}%`
            : '—', '最大ROI', 'profit'),
    ].join('');

    // アラート
    if (data.alerts.length > 0) {
        alertsList.innerHTML = data.alerts
            .sort((a, b) => b.profit.netProfit - a.profit.netProfit)
            .map(a => renderAlertCard(a))
            .join('');
    } else {
        alertsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <p class="empty-state-text">しきい値を超える商品は見つかりませんでした</p>
            </div>`;
    }

    // 商品グリッド
    if (data.products.length > 0) {
        productsGrid.innerHTML = data.products
            .map(p => renderProductCard(p))
            .join('');
    } else {
        productsGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <p class="empty-state-text">商品が見つかりませんでした</p>
            </div>`;
    }
}

function cardHTML(icon, value, label, type) {
    return `
        <div class="summary-card ${type}">
            <div class="card-icon">${icon}</div>
            <div class="card-value">${value}</div>
            <div class="card-label">${label}</div>
        </div>`;
}

function renderAlertCard(alert) {
    const { product, priceData, productId, sourceItem, profit, source } = alert;
    const title = (product.nameJP || product.nameEN || productId).substring(0, 60);
    const roiClass = profit.roi >= 100 ? 'hot' : profit.roi >= 50 ? 'warm' : '';

    const mercariUrl = getMercariSearchUrl(productId);
    const yahooUrl = getYahooAuctionSearchUrl(productId);

    return `
        <div class="alert-card ${roiClass}">
            <div class="alert-header">
                <div class="alert-title">${title}</div>
                <div class="alert-profit-badge ${profit.roi >= 100 ? 'hot' : ''}">
                    +¥${profit.netProfit.toLocaleString()} (${profit.roi}%)
                </div>
            </div>
            <div class="alert-details">
                <div class="alert-detail">
                    <div class="alert-detail-label">🛍️ 楽天仕入れ</div>
                    <div class="alert-detail-value">¥${profit.buyPrice.toLocaleString()}</div>
                </div>
                <div class="alert-detail">
                    <div class="alert-detail-label">👟 スニダン販売</div>
                    <div class="alert-detail-value text-success">¥${profit.sellPrice.toLocaleString()}</div>
                </div>
                <div class="alert-detail">
                    <div class="alert-detail-label">💵 純利益</div>
                    <div class="alert-detail-value text-success">+¥${profit.netProfit.toLocaleString()}</div>
                </div>
                <div class="alert-detail">
                    <div class="alert-detail-label">📊 ROI</div>
                    <div class="alert-detail-value">${profit.roi}%</div>
                </div>
                <div class="alert-detail">
                    <div class="alert-detail-label">📉 手数料+送料</div>
                    <div class="alert-detail-value text-muted">¥${(profit.snkrdunkFee + profit.shipping).toLocaleString()}</div>
                </div>
                <div class="alert-detail">
                    <div class="alert-detail-label">👟 スニダン相場</div>
                    <div class="alert-detail-value">¥${priceData.minPrice.toLocaleString()}〜¥${priceData.maxPrice.toLocaleString()}</div>
                </div>
            </div>
            <div class="alert-footer">
                <div class="alert-links">
                    <a href="${sourceItem.url}" target="_blank" class="alert-link buy-link">🛍️ 楽天で購入</a>
                    <a href="https://snkrdunk.com/products/${productId}" target="_blank" class="alert-link snkrdunk-link">👟 スニダン</a>
                    <a href="${mercariUrl}" target="_blank" class="alert-link mercari-link">📱 メルカリ</a>
                    <a href="${yahooUrl}" target="_blank" class="alert-link yahoo-link">🔨 ヤフオク</a>
                </div>
            </div>
        </div>`;
}

function renderProductCard(p) {
    const name = (p.product.nameJP || p.product.nameEN || p.id).substring(0, 50);
    const imgUrl = p.product.eyeCatchImageUrl || '';

    return `
        <a href="https://snkrdunk.com/products/${p.id}" target="_blank" class="product-card">
            ${imgUrl ? `<img src="${imgUrl}" alt="" class="product-img" onerror="this.style.display='none'">` : '<div class="product-img"></div>'}
            <div class="product-info">
                <div class="product-name">${name}</div>
                <div class="product-price">¥${p.priceData.minPrice.toLocaleString()}</div>
                <div class="product-meta">
                    平均¥${p.priceData.avgPrice.toLocaleString()} / 出品${p.priceData.totalListings}件
                </div>
            </div>
        </a>`;
}

// ============================================================
//  UI ヘルパー
// ============================================================

function showLoading() {
    loading.style.display = 'block';
    resultsSection.style.display = 'none';
    searchBtn.disabled = true;
    scanPopularBtn.disabled = true;
    progressBar.style.width = '0%';
}

function hideLoading() {
    loading.style.display = 'none';
    searchBtn.disabled = false;
    scanPopularBtn.disabled = false;
}

function updateLoading(text, detail) {
    loadingText.textContent = text;
    loadingDetail.textContent = detail;
}

function showError(msg) {
    errorBanner.style.display = 'flex';
    errorText.textContent = msg;
}

function hideError() {
    errorBanner.style.display = 'none';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
