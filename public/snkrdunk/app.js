/**
 * Snkrdunk Arbitrage ダッシュボード — フロントエンドJS v5
 *
 * サーバーの /api/snkrdunk-status エンドポイントからスキャン結果を取得し、
 * リアルタイムでダッシュボードに表示する。
 * 30秒ごとに自動更新。
 */

// ============================================================
//  DOM参照
// ============================================================

const $ = id => document.getElementById(id);

const statusBadge = $('statusBadge');
const nextScanTimer = $('nextScanTimer');
const refreshBtn = $('refreshBtn');

// ステータスバー
const elLastScan = $('lastScan');
const elElapsed = $('elapsed');
const elTotalProducts = $('totalProducts');
const elTotalYahoo = $('totalYahoo');
const elTotalRakuten = $('totalRakuten');

// サマリー
const elAlertCount = $('alertCount');
const elCandidateCount = $('candidateCount');
const elMaxProfit = $('maxProfit');
const elMaxRoi = $('maxRoi');

// コンテンツ
const alertBadge = $('alertBadge');
const alertsList = $('alertsList');
const productBadge = $('productBadge');
const productsGrid = $('productsGrid');

// ============================================================
//  設定
// ============================================================

/** 自動更新間隔（ミリ秒） */
const REFRESH_INTERVAL = 15000;

/** スニダン手数料 */
const SNKRDUNK_FEE_RATE = 0.065;
const SNKRDUNK_SHIPPING = 990;

/** スキャン間隔（モニターの設定と合わせる） */
const SCAN_INTERVAL_MIN = 30;

/** 最終スキャン時刻（カウントダウン用） */
let lastScannedAt = null;

// ============================================================
//  初期化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    fetchData();
    setInterval(fetchData, REFRESH_INTERVAL);
    setInterval(updateTimer, 1000);
    refreshBtn.addEventListener('click', () => {
        refreshBtn.style.animation = 'none';
        void refreshBtn.offsetWidth;
        refreshBtn.style.animation = '';
        fetchData();
    });
});

// ============================================================
//  データ取得
// ============================================================

async function fetchData() {
    try {
        const res = await fetch('/api/snkrdunk-status', {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.status === 'no_data') {
            setBadge('offline', 'NO DATA');
            return;
        }
        if (data.status === 'error') {
            setBadge('offline', 'ERROR');
            return;
        }

        lastScannedAt = new Date(data.scannedAt);
        const minutesAgo = Math.round((Date.now() - lastScannedAt.getTime()) / 60000);

        if (minutesAgo > 60) {
            setBadge('stale', `${minutesAgo}分前`);
        } else {
            setBadge('live', 'LIVE');
        }

        renderStatusBar(data, minutesAgo);
        renderSummary(data);
        renderAlerts(data.alerts || []);
        renderProducts(data.products || []);

    } catch {
        setBadge('offline', 'OFFLINE');
    }
}

// ============================================================
//  バッジ更新
// ============================================================

function setBadge(cls, text) {
    statusBadge.className = `badge ${cls}`;
    statusBadge.textContent = text;
}

// ============================================================
//  タイマー更新
// ============================================================

function updateTimer() {
    if (!lastScannedAt) {
        nextScanTimer.textContent = '--:--';
        return;
    }
    const nextScan = new Date(lastScannedAt.getTime() + SCAN_INTERVAL_MIN * 60 * 1000);
    const diff = Math.max(0, nextScan - Date.now());
    const min = Math.floor(diff / 60000);
    const sec = Math.floor((diff % 60000) / 1000);
    nextScanTimer.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ============================================================
//  ステータスバー描画
// ============================================================

function renderStatusBar(data, minutesAgo) {
    elLastScan.textContent = minutesAgo <= 1 ? 'たった今' : `${minutesAgo}分前`;
    elElapsed.textContent = `${data.elapsedSeconds}秒`;
    elTotalProducts.textContent = `${data.totalProducts}件`;
    elTotalYahoo.textContent = `${data.totalYahoo}件`;
    elTotalRakuten.textContent = `${data.totalRakuten}件`;
}

// ============================================================
//  サマリー描画
// ============================================================

function renderSummary(data) {
    const alerts = data.alerts || [];
    elAlertCount.textContent = data.totalAlerts || 0;
    elCandidateCount.textContent = data.totalCandidates || 0;

    if (alerts.length > 0) {
        const maxP = Math.max(...alerts.map(a => a.netProfit));
        const maxR = Math.max(...alerts.map(a => a.roi));
        elMaxProfit.textContent = `¥${maxP.toLocaleString()}`;
        elMaxRoi.textContent = `${maxR}%`;
    } else {
        elMaxProfit.textContent = '—';
        elMaxRoi.textContent = '—';
    }
}

// ============================================================
//  アラート描画
// ============================================================

function renderAlerts(alerts) {
    alertBadge.textContent = `${alerts.length}件`;

    if (alerts.length === 0) {
        alertsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔍</div>
                <div class="empty-text">現在アラートなし</div>
                <div class="empty-sub">次のスキャンで候補が見つかると表示されます</div>
            </div>`;
        return;
    }

    // 利益の高い順にソート
    const sorted = [...alerts].sort((a, b) => b.netProfit - a.netProfit);

    alertsList.innerHTML = sorted.map((a, i) => {
        const isHot = a.roi >= 100;
        const sourceEmoji = a.source === 'yahoo' ? '🔨' : '🛍️';
        const sourceLabel = a.source === 'yahoo' ? 'Yahoo' : '楽天';
        const mercariUrl = `https://jp.mercari.com/search?keyword=${encodeURIComponent(a.productId)}&status=on_sale&order=desc&sort=created_time`;
        const yahooAucUrl = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(a.productId)}`;

        return `
        <div class="alert-card ${isHot ? 'hot' : ''}" style="animation-delay: ${i * 0.06}s">
            <div class="alert-top">
                ${a.image ? `<img src="${a.image}" alt="" class="alert-img" onerror="this.style.display='none'">` : ''}
                <div class="alert-info">
                    <div class="alert-title">${escHtml(a.productName)}</div>
                    <div class="alert-source">${sourceEmoji} ${escHtml(a.sourceTitle || sourceLabel)} </div>
                </div>
                <div class="alert-profit-badge ${isHot ? 'hot' : ''}">
                    +¥${a.netProfit.toLocaleString()}
                    <span class="roi-text">ROI ${a.roi}%</span>
                </div>
            </div>
            <div class="alert-metrics">
                <div class="alert-metric">
                    <span class="metric-label">${sourceEmoji} 仕入れ</span>
                    <span class="metric-value">¥${a.buyPrice.toLocaleString()}</span>
                </div>
                <div class="alert-metric">
                    <span class="metric-label">👟 スニダン販売</span>
                    <span class="metric-value text-success">¥${a.sellPrice.toLocaleString()}</span>
                </div>
                <div class="alert-metric">
                    <span class="metric-label">💵 純利益</span>
                    <span class="metric-value text-success">+¥${a.netProfit.toLocaleString()}</span>
                </div>
                <div class="alert-metric">
                    <span class="metric-label">📉 手数料+送料</span>
                    <span class="metric-value text-muted">¥${(a.fee + a.shipping).toLocaleString()}</span>
                </div>
                <div class="alert-metric">
                    <span class="metric-label">📩 オファー数</span>
                    <span class="metric-value">${a.offerCount}件</span>
                </div>
                <div class="alert-metric">
                    <span class="metric-label">📈 出品数</span>
                    <span class="metric-value">${a.listings}件</span>
                </div>
            </div>
            <div class="alert-links">
                <a href="${escHtml(a.sourceUrl)}" target="_blank" class="alert-link">${sourceEmoji} ${sourceLabel}で購入</a>
                <a href="https://snkrdunk.com/products/${encodeURIComponent(a.productId)}" target="_blank" class="alert-link">👟 スニダン</a>
                <a href="${mercariUrl}" target="_blank" class="alert-link">📱 メルカリ</a>
                <a href="${yahooAucUrl}" target="_blank" class="alert-link">🔨 ヤフオク</a>
            </div>
        </div>`;
    }).join('');
}

// ============================================================
//  商品グリッド描画
// ============================================================

function renderProducts(products) {
    productBadge.textContent = `${products.length}件`;

    if (products.length === 0) {
        productsGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">👟</div>
                <div class="empty-text">商品データなし</div>
            </div>`;
        return;
    }

    productsGrid.innerHTML = products.map(p => `
        <a href="https://snkrdunk.com/products/${encodeURIComponent(p.id)}" target="_blank" class="product-card">
            ${p.image ? `<img src="${p.image}" alt="" class="product-img" onerror="this.style.display='none'">` : '<div class="product-img"></div>'}
            <div class="product-info">
                <div class="product-name">${escHtml(p.name)}</div>
                <div class="product-prices">
                    <span class="product-price">¥${p.minPrice.toLocaleString()}</span>
                    ${p.hasOffers ? `<span class="product-offer-tag">📩 ${p.offers}件</span>` : ''}
                </div>
                ${p.hasOffers ? `<div class="product-offers">オファー ¥${p.offerMin.toLocaleString()}〜¥${p.offerMax.toLocaleString()}</div>` : ''}
            </div>
        </a>
    `).join('');
}

// ============================================================
//  ユーティリティ
// ============================================================

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
