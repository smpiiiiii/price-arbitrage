/**
 * eBay HTTPスクレイパー（軽量版）
 *
 * Puppeteerを使わず、単純なHTTP fetch + Cheerioで
 * eBayの検索結果をスクレイピングする。
 * ブラウザ起動不要→クラッシュしない。
 */

import * as cheerio from 'cheerio';

// ユーザーエージェントローテーション
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
];

/**
 * ランダムなユーザーエージェントを取得
 */
function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * eBayの売却済み・出品中商品をHTTPスクレイピングで検索する
 * @param {string} keyword - 検索キーワード
 * @param {object} [options] - オプション
 * @param {boolean} [options.sold=false] - 売却済みのみ検索
 * @param {number} [options.minPrice=0] - 最低価格（USD）
 * @returns {Promise<Array>}
 */
export async function scrapeEbay(keyword, options = {}) {
    const { sold = false, minPrice = 0 } = options;

    // フォールバック戦略: 複数のアプローチを順番に試す
    const strategies = [
        () => tryEbaySite('https://www.ebay.com', keyword, sold, minPrice),
        () => tryEbaySite('https://www.ebay.co.uk', keyword, sold, minPrice),
        () => tryEbayRss(keyword),
    ];

    for (const strategy of strategies) {
        const items = await strategy();
        if (items.length > 0) return items;
    }

    console.warn('⚠️ eBay: 全ての取得方法が失敗しました');
    return [];
}

/**
 * eBayサイトからHTTPスクレイピング
 */
async function tryEbaySite(baseUrl, keyword, sold, minPrice) {
    const encodedKeyword = encodeURIComponent(keyword);
    let url = `${baseUrl}/sch/i.html?_nkw=${encodedKeyword}&_sop=12`;
    if (sold) url += '&LH_Sold=1&LH_Complete=1';
    if (minPrice > 0) url += `&_udlo=${minPrice}`;

    const site = new URL(baseUrl).hostname;
    console.log(`🌐 eBay HTTP検索 (${site}): "${keyword}" ${sold ? '(売却済み)' : '(出品中)'}`);

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': randomUA(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
        });

        if (!res.ok) {
            console.error(`  ⚠️ ${site} HTTPエラー: ${res.status}`);
            return [];
        }

        const html = await res.text();

        if (html.includes('Pardon Our Interruption') || html.includes('Press & Hold') ||
            html.includes('captcha') || html.includes('Security Measure')) {
            console.warn(`  ⚠️ ${site} ボット検知 — 次の方法を試行`);
            return [];
        }

        const items = parseEbayResults(html, sold);
        console.log(`  → ${site}: ${items.length}件取得`);
        return items;

    } catch (err) {
        console.error(`  ⚠️ ${site} エラー: ${err.message}`);
        return [];
    }
}

/**
 * eBay RSSフィードから商品を取得（ボット検知されにくい）
 */
async function tryEbayRss(keyword) {
    const encodedKeyword = encodeURIComponent(keyword);
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodedKeyword}&_rss=1`;

    console.log(`🌐 eBay RSS検索: "${keyword}"`);

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': randomUA(),
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
        });

        if (!res.ok) {
            console.error(`  ⚠️ eBay RSS HTTPエラー: ${res.status}`);
            return [];
        }

        const xml = await res.text();

        if (xml.includes('Pardon Our Interruption') || xml.includes('captcha')) {
            console.warn('  ⚠️ eBay RSS もボット検知');
            return [];
        }

        const $ = cheerio.load(xml, { xmlMode: true });
        const items = [];

        $('item').each((i, el) => {
            const $el = $(el);
            const title = $el.find('title').text().trim();
            const link = $el.find('link').text().trim();

            if (!title) return;

            // 価格の抽出を試みる
            const description = $el.find('description').text();
            const priceMatch = description.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
            const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

            // 画像URLの抽出
            const imgMatch = description.match(/src=["']([^"']+)/);
            const imageUrl = imgMatch ? imgMatch[1] : '';

            if (price > 0) {
                items.push({
                    title,
                    price,
                    currency: 'USD',
                    priceText: `$${price.toFixed(2)}`,
                    soldDate: '',
                    url: cleanUrl(link),
                    imageUrl: cleanImageUrl(imageUrl),
                    shippingCost: null,
                    shippingCurrency: 'USD',
                    condition: '',
                    location: '',
                });
            }
        });

        console.log(`  → eBay RSS: ${items.length}件取得`);
        return items;

    } catch (err) {
        console.error(`  ⚠️ eBay RSS エラー: ${err.message}`);
        return [];
    }
}

/**
 * eBay検索結果HTMLをパースする
 * @param {string} html
 * @param {boolean} sold - 売却済みかどうか
 * @returns {Array}
 */
function parseEbayResults(html, sold = false) {
    const $ = cheerio.load(html);
    const items = [];

    $('.s-item').each((i, el) => {
        try {
            const $el = $(el);

            // タイトル
            const title = $el.find('.s-item__title span, .s-item__title').first().text().trim();
            if (!title || title === 'Shop on eBay' || title === 'Results matching fewer words') return;

            // 価格
            const priceText = $el.find('.s-item__price').first().text().trim();
            const priceData = parsePrice(priceText);
            if (!priceData) return;

            // URL
            const itemUrl = $el.find('.s-item__link').attr('href') || '';

            // 画像
            const imageUrl = $el.find('.s-item__image-img').attr('src') ||
                $el.find('.s-item__image-img').attr('data-src') || '';

            // 売却日（売却済みの場合）
            const soldDateText = $el.find('.s-item__title--tagblock .POSITIVE, .s-item__ended-date, .POSITIVE').text().trim();
            const soldDate = parseSoldDate(soldDateText);

            // 配送料
            const shippingText = $el.find('.s-item__shipping, .s-item__freeXDays').text().trim();
            const shippingCost = parseShippingCost(shippingText);

            items.push({
                title,
                price: priceData.amount,
                currency: priceData.currency,
                priceText,
                soldDate,
                url: cleanUrl(itemUrl),
                imageUrl: cleanImageUrl(imageUrl),
                shippingCost,
                shippingCurrency: 'USD',
                condition: '',
                location: '',
            });
        } catch {
            // 個別アイテムのパースエラーは無視
        }
    });

    return items;
}

/**
 * 価格テキストをパースする
 */
function parsePrice(text) {
    if (!text) return null;

    // レンジ価格: 高い方を使用
    const rangeMatch = text.match(/to\s/);
    const target = rangeMatch ? text.split('to').pop().trim() : text.trim();

    // USD
    const usdMatch = target.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    if (usdMatch) {
        return { amount: parseFloat(usdMatch[1].replace(/,/g, '')), currency: 'USD' };
    }

    // JPY
    const jpyMatch = target.match(/(?:JPY|¥)\s?([\d,]+)/);
    if (jpyMatch) {
        return { amount: parseFloat(jpyMatch[1].replace(/,/g, '')), currency: 'JPY' };
    }

    // EUR
    const eurMatch = target.match(/(?:EUR|€)\s?([\d,]+(?:\.\d{2})?)/);
    if (eurMatch) {
        return { amount: parseFloat(eurMatch[1].replace(/,/g, '')), currency: 'EUR' };
    }

    // GBP
    const gbpMatch = target.match(/(?:GBP|£)\s?([\d,]+(?:\.\d{2})?)/);
    if (gbpMatch) {
        return { amount: parseFloat(gbpMatch[1].replace(/,/g, '')), currency: 'GBP' };
    }

    return null;
}

/**
 * 売却日をパースする
 */
function parseSoldDate(text) {
    if (!text) return '';
    const months = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };
    const match = text.match(/(?:Sold\s+)?(\w{3})\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
        const [, mon, day, year] = match;
        const mm = months[mon] || '01';
        return `${year}-${mm}-${day.padStart(2, '0')}`;
    }
    return '';
}

/**
 * 配送料テキストから金額を抽出
 */
function parseShippingCost(text) {
    if (!text) return null;
    if (text.toLowerCase().includes('free')) return 0;
    const match = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

/**
 * eBay URLからトラッキングパラメータを除去
 */
function cleanUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

/**
 * eBay画像URLのサイズを大きくする
 */
function cleanImageUrl(url) {
    if (!url) return '';
    // s-l225 → s-l500 に置換して大きい画像にする
    return url.replace(/s-l\d+/, 's-l500');
}
