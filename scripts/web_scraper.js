const puppeteer = require('puppeteer');
const robotsParser = require('robots-parser');
const fs = require('fs');

const CONTENT_LOAD_TIMEOUT = 60000;
const LINKS_CONTAINER_SELECTOR = '#logoslist';
const SEARCH_KEYWORDS = {
    careers: ['career', 'karjaar', 'tootamine', 'join-', 'liitu-', 'toopakkumised', 'tookohad', 'join', 'liitu','teamtailor', 'jobs', 'cv'],
    internship: ['internship', 'praktika', 'apprenticeship', 'apprentice', 'student'],
    company: ['about-us', 'about-group', 'company', 'meist', 'meeskond', 'ettevottest'],
    contact: ['contact', 'lets-connect', 'kontakt']
};

async function scrapeCompaniesWebsiteData(url) {
    let browser;
    try {
        browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForSelector(LINKS_CONTAINER_SELECTOR);

        const { companyWebsiteLinks, companyNames } = await fetchHomepageLinksAndText(page);

        const companiesData = await Promise.all(companyWebsiteLinks.map(async (homepageLink, index) => {
            console.log(`Processing link ${index + 1}/${companyWebsiteLinks.length}: ${homepageLink}`);

            if (await isAllowedToCrawl(browser, homepageLink)) {
                const name = companyNames[index];

                console.log(`Fetching links for ${name}`);
                const [careersLink, internshipLink, aboutLink, contactLink] = await fetchCompanyLinks(browser, homepageLink);
                console.log(`Finished fetching links for ${name}`);
    
                return { name, homepageLink, careersLink, internshipLink, aboutLink, contactLink };
            }
            
            console.log(`Skipping ${homepageLink} as per robots.txt`);
            return null;
        }));
        console.log('All links processed.');

        const filteredCompaniesData = companiesData.filter(Boolean);
        const jsonData = JSON.stringify(filteredCompaniesData, null, 2);
        fs.writeFileSync('../scraped_data/data.json', jsonData);
        console.log('Data saved to file.');
    } catch (error) {
        console.error('Error occurred:', error);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function fetchHomepageLinksAndText(page) {
    return page.evaluate(() => {
        const extractDomainNameWithoutWWW = (url) => {
            const hostname = new URL(url).hostname;
            return hostname.startsWith('www.') ? hostname.split('.')[1] : hostname.split('.')[0];
        };

        const cleanURL = (url) => {
            const BLACKLISTED_DOMAINS = ['ut', 'tlu', 'taltech', 'euas', 'kood', 'tktk', 'tptlive'];
            const parsedUrl = new URL(url);
            const domainName = extractDomainNameWithoutWWW(parsedUrl);
            return BLACKLISTED_DOMAINS.includes(domainName) ? null : `${parsedUrl.protocol}//${parsedUrl.hostname}/`;
        };

        const div = document.getElementById('logoslist');
        const links = div.querySelectorAll('a');
        const companyWebsiteLinks = Array.from(links, link => cleanURL(link.href));
        const companyNames = Array.from(links, link => link.querySelector('span').textContent.trim().replace(/^\d+\./, '').trim());
        return { companyWebsiteLinks, companyNames };
    });
}

async function fetchCompanyLinks(browser, homepageLink) {
    let page;
    try {
        page = await browser.newPage();
        const response = await page.goto(homepageLink, { waitUntil: 'domcontentloaded', timeout: CONTENT_LOAD_TIMEOUT });
        if (response.ok()) {
            const pageLinksData = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'), tag => ({
                    text: tag.innerText.trim(),
                    href: tag.href.trim()
                }));
            });
    
            const pageLinkTexts = pageLinksData.map(item => item.text);
            const pageLinkURLs = pageLinksData.map(item => item.href);
    
            let [careersLink, internshipLink, aboutLink, contactLink] = await Promise.all([
                findMatchURL(pageLinkURLs, pageLinkTexts, SEARCH_KEYWORDS.careers),
                findMatchURL(pageLinkURLs, pageLinkTexts, SEARCH_KEYWORDS.internship),
                findMatchURL(pageLinkURLs, pageLinkTexts, SEARCH_KEYWORDS.company),
                findMatchURL(pageLinkURLs, pageLinkTexts, SEARCH_KEYWORDS.contact),
            ]);
    
            if (!internshipLink && careersLink && await isAllowedToCrawl(browser, careersLink)) {
                internshipLink = await fetchInternshipPage(browser, careersLink);
            }
    
            return [careersLink, internshipLink, aboutLink, contactLink];
        }

        console.error(`Error occurred for ${homepageLink}: HTTP status ${response.status()}`);
        return [null, null, null, null];
    } catch (error) {
        console.error(`Error occurred for ${homepageLink}:`, error);
        return [null, null, null, null];
    } finally {
        if (page) {
            await page.close();
        }
    }
}

async function fetchInternshipPage(browser, link) {
    let page;
    try {
        page = await browser.newPage();
        const response = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: CONTENT_LOAD_TIMEOUT });

        if (response.ok()) {
            const pageLinksData = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'), tag => ({
                    text: tag.innerText.trim(),
                    href: tag.href.trim()
                }));
            });
    
            const pageLinkTexts = pageLinksData.map(item => item.text);
            const pageLinkURLs = pageLinksData.map(item => item.href);
            const internshipLink = await findMatchURL(pageLinkURLs, pageLinkTexts, SEARCH_KEYWORDS.internship);
            return internshipLink;
        }

        console.error(`Error occurred for ${link}: HTTP status ${response.status()}`);
        return null;
    } catch (error) {
        console.error(`Error occurred for ${link}:`, error);
        return null;
    } finally {
        if (page) {
            await page.close();
        }
    }
}

async function findMatchURL(urls, texts, keywords) {
    for (let i = 0; i < urls.length; i++) {
        const currentURL = urls[i];
        const currentText = texts[i];
        if (keywords.some(keyword => currentText.toLowerCase().includes(keyword.toLowerCase()))) {
            return currentURL;
        }
    }

    for (const url of urls) {
        if (keywords.some(keyword => url.toLowerCase().includes(keyword.toLowerCase()))) {
            return url;
        }
    }
    
    return null;
}

async function isAllowedToCrawl(browser, url) {
    let page;
    try {
        if (!url) return false;

        page = await browser.newPage();
        const parsedUrl = new URL(url);
        const cleanURL = `${parsedUrl.protocol}//${parsedUrl.hostname}/`;

        const robotsTxtUrl = new URL('/robots.txt', cleanURL).href;
        const robotsTxtPage = await page.goto(robotsTxtUrl, { waitUntil: 'domcontentloaded' });
        if (robotsTxtPage.status() == 200) {
            const robotsTxtContent = await robotsTxtPage.text();
            const robots = robotsParser(cleanURL, robotsTxtContent);
            return robots.isAllowed(url, '*');
        }

        console.error(`Failed to fetch robots.txt for ${cleanURL}`);
        return false;
    } catch (error) {
        console.error(`Error occurred while checking robots.txt for ${url}:`, error);
        return false;
    } finally {
        if (page) {
            await page.close();
        }
    }
}

scrapeCompaniesWebsiteData('https://itl.ee/en/members/');