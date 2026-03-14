/**
 * Price Arbitrage — フロントエンドアプリケーション
 *
 * 検索UI、API呼び出し、結果表示を管理する。
 */

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
//  API呼び出し
// ============================================================

/**
 * プリセット一覧を取得して表示する
 */
async function loadPresets() {
    try {
        const res = await fetch('/api/presets');
        const data = await res.json();

        presetsContainer.innerHTML = data.presets.map(preset =>
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
    } catch (err) {
        console.error('プリセット読み込みエラー:', err);
    }
}

/**
 * 為替レートを取得して表示する
 */
async function loadRates() {
    try {
        const res = await fetch('/api/rates');
        const data = await res.json();
        rateDisplay.textContent = `💱 1 USD = ¥${data.usdToJpy.toFixed(1)}`;
    } catch {
        // エラー時はデフォルト表示のまま
    }
}

/**
 * サーバーステータスを取得してモードバッジを更新
 */
async function loadStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();

        if (data.mode === 'demo') {
            modeBadge.textContent = 'DEMO';
            modeBadge.className = 'badge';
        } else if (data.mode === 'api') {
            modeBadge.textContent = 'API';
            modeBadge.className = 'badge live';
        } else {
            modeBadge.textContent = 'LIVE';
            modeBadge.className = 'badge live';
        }
    } catch {
        // エラー時はデフォルト
    }
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
        let url = `/api/search?q=${encodeURIComponent(keyword)}`;
        if (ebayKw) url += `&ebayKeyword=${encodeURIComponent(ebayKw)}`;
        if (rakutenKw) url += `&rakutenKeyword=${encodeURIComponent(rakutenKw)}`;

        const res = await fetch(url);

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `サーバーエラー (${res.status})`);
        }

        const data = await res.json();

        if (data.error) {
            showError(data.error);
            return;
        }

        renderResults(data);
    } catch (err) {
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
    } else if (data.mode === 'scrape') {
        const sources = data.dataSources ? `eBay: ${data.dataSources.ebay} / 楽天: ${data.dataSources.rakuten}` : '';
        const bannerColor = data.ebaySource === 'reference'
            ? 'background:rgba(139,92,246,0.12);color:#a78bfa;border-color:rgba(139,92,246,0.3);'
            : 'background:rgba(16,185,129,0.12);color:#10b981;border-color:rgba(16,185,129,0.3);';
        const icon = data.ebaySource === 'reference' ? '📊' : '🌐';
        const label = data.ebaySource === 'reference' ? 'リアルデータ — 楽天（実データ）+ eBay（参考価格）' : 'リアルデータ — HTTPスクレイピングで取得';
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
    // eBay検索用キーワード（英語）— 検索入力欄の値を使用
    const ebaySearchKeyword = data.keyword || searchInput.value || 'japanese products';
    if (opportunities.length > 0) {
        opportunitiesList.innerHTML = opportunities.map(opp => {
            const isProfitable = opp.netProfit > 0;
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
                        <div class="opp-links">
                            ${opp.domesticUrl ? `<a class="opp-link buy-link" href="${escapeHtml(opp.domesticUrl)}" target="_blank" rel="noopener">🛒 楽天で購入 →</a>` : ''}
                            <a class="opp-link sold-link" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebaySearchKeyword)}&LH_Sold=1&LH_Complete=1&_sop=13" target="_blank" rel="noopener">✅ eBay落札実績 →</a>
                            <a class="opp-link ebay-link" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebaySearchKeyword)}&_sop=13" target="_blank" rel="noopener">🔍 eBay出品中 →</a>
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
