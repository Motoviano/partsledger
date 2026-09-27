# Partsledger – Motoviano profit app

Profit dashboard for the Motoviano eBay accounts (Newgates19uk, Autonation, Technofest) and, later, Amazon Motoviano.
You upload reports; the app works out profit per sale, per product, per account and per period.

## What's in it

| Page | What it does |
|---|---|
| Dashboard | This week, last week, month to date, month forecast, last month. Product table for any period. |
| Sold items | Every item sold with sale price, eBay fees, ads, postage, refund, COGS, profit. Set a SKU for listings that have none. Export CSV. |
| COGS | One cost per SKU. Change it for all sales, or from a date (past months keep the old cost). Price bands for SKUs without a cost. |
| Charts | Profit by month per account, weekly sales and orders, profit by product group, top 10 products. |
| Uploads | Drop in reports. Rows already loaded are skipped, so overlapping date ranges are safe. |
| Users | Add people, reset passwords, download a database backup (admins). |

Filters on every page: accounts (tick any), product groups (tick any, from the letters at the start of the SKU), and dates
(this/last week, month to date, last month, this/last quarter, this/last VAT quarter, year to date, custom).

### Files you can upload

* **eBay Transaction report** (Seller Hub → Payments → Reports → Transaction report, CSV). The account is read from the file.
* **eBay All active listings report** (Seller Hub → Reports → Downloads, CSV). Gives SKUs, titles and prices. Upload transaction reports first, or pick the account on the Uploads page.
* **COGS list** (CSV or Excel) with a SKU column and a cost or COGS column.
* **Amazon Date Range report** (Seller Central → Payments → Reports repository → Transaction, CSV). This importer hasn't been tested on a real Motoviano file yet; send the first file to check the numbers.

### How profit is worked out

* Sales, eBay fees, ads and postage labels are the amounts in eBay's reports.
* Postage and refunds belong to an order; in multi-item orders they're split by each item's share of the order value.
* A full refund counts as a return: the part comes back, so its COGS is added back. The loss is postage and any fees not refunded.
* COGS: the SKU's cost on the sale date. If there's no cost, the price band for the item's price is used (editable on the COGS page).
* Insertion fees, the shop subscription and anything not tied to a sale show as "Other fees" in the tiles.
* Motoviano isn't VAT-registered, so sale prices and costs are used as they are, including VAT.

---

## Putting it online (about 30 minutes, once)

You need three things: a GitHub account (stores the code), a Render account (runs the app) and access to your Shopify domain settings.

### 1. Put the code on GitHub

1. Create a free account at **github.com**.
2. Click **New repository**. Name it `partsledger`, choose **Private**, tick **Add a README file**, then **Create repository**.
3. Unzip `partsledger.zip` on your computer.
4. In the repository, click **Add file → Upload files**. Drag in **everything inside** the unzipped `partsledger` folder
   (the `app` and `seed` folders, `render.yaml`, `requirements.txt`, `README.md`, `.gitignore`). Click **Commit changes**.
   * If `.gitignore` doesn't show on your computer, that's fine; it's optional.

### 2. Run it on Render

1. Create an account at **render.com** and choose **Sign up with GitHub**. Allow Render to see the `partsledger` repository.
2. Add a payment card (Account settings → Billing). The app needs a paid instance so the database is kept on disk:
   the Starter instance is about $7 a month plus about $0.25 a month for the 1 GB disk.
3. Click **New → Blueprint**, pick the `partsledger` repository, and click **Apply**. Render reads `render.yaml` and sets everything up.
4. It asks for three values. These create the first login:
   * `ADMIN_NAME` – your name
   * `ADMIN_EMAIL` – the email you'll log in with
   * `ADMIN_PASSWORD` – at least 8 characters (change it later on the Users page)
5. Wait for the deploy to show **Live** (3–5 minutes). Open the `https://partsledger-xxxx.onrender.com` address it shows and log in.
6. Go to **Uploads** and drop in the three eBay Transaction reports, then the three All active listings reports.
   Costs you've already agreed (supplier file, your own costs, SKU corrections) are loaded automatically on first start.
7. On **Users**, add everyone who needs access.

### 3. Use your own address (optional)

Example: `profit.yourdomain.com`.

1. In Render: open the service → **Settings → Custom Domains → Add**, type `profit.yourdomain.com`. Render shows a target like `partsledger-xxxx.onrender.com`.
2. In Shopify admin: **Settings → Domains**, click your domain, then **Domain settings → Edit DNS settings → Add custom record → CNAME**.
   * Name: `profit`
   * Points to: the Render target from step 1
3. Back in Render, click **Verify**. The secure certificate is issued automatically, usually within an hour.

If your domain was bought somewhere else (GoDaddy, Namecheap…) and only connected to Shopify, add the CNAME record at that company instead.

### Updating the app later

Change files in the GitHub repository (or upload new versions). Render redeploys automatically; the data on the disk stays.

### Backups

Render takes daily snapshots of the disk. You can also download a copy any time from **Users → Download database backup** (admins).

---

## Running it on a computer (for testing)

```bash
pip install -r requirements.txt
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=choose-one HTTPS_ONLY=0 uvicorn app.main:app --port 8000
```
Then open http://localhost:8000. The database is created in `data/partsledger.db`.
