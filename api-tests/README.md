# 125 EAST — Meta Ads API Test Suite & Postman Collection

This directory contains automated integration tests and the Postman collection for **Meta Marketing Intelligence APIs**.

---

## 1. Automated Postman Collection

The collection has been uploaded to your Postman Workspace:
- **Workspace:** `Aruuna Somesh's Workspace`
- **Collection Name:** `125 EAST - Meta Ads API Tests`
- **UID:** `58819832-8342b6e1-5be7-428d-9e15-574d7b94d571`
- **Local File:** `meta-ads.postman_collection.json`

### Included Requests in Postman folder `API Tests`:
1. **`GET 1. Get Meta Marketing Stats (Backend Proxy)`**
   - URL: `http://127.0.0.1:8001/api/w/{{workspace_slug}}/b/{{brand_id}}/marketing/stats/`
   - Tests:
     - `pm.test("Status code is 200")`
     - `pm.test("Response contains connection status")`
     - `pm.test("Verify 30D spend and ROAS metrics in minor units paise")`
     - `pm.test("Verify campaigns array structure")`

2. **`POST 2. Trigger Meta On-Demand Sync`**
   - URL: `http://127.0.0.1:8001/api/w/{{workspace_slug}}/b/{{brand_id}}/marketing/sync-now/`
   - Tests:
     - `pm.test("Status code is 200 or handles gateway response")`
     - `pm.test("Response returns structured status or error")`

3. **`GET 3. Meta Graph API - Verify Ad Account`**
   - URL: `https://graph.facebook.com/v21.0/act_{{ad_account_id}}?fields=id,name,currency...`
   - Tests:
     - `pm.test("Response is valid JSON")`
     - `pm.test("Account ID matches")`

4. **`GET 4. Meta Graph API - 30D Insights Breakdown`**
   - URL: `https://graph.facebook.com/v21.0/act_{{ad_account_id}}/insights?...`
   - Tests:
     - `pm.test("Insights returns data array")`

---

## 2. Running Automated Pytest Suite

To run the automated backend test cases:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_meta_ads_api.py -v
```

All 4 test cases verify:
- ✅ Ad account ID prefix normalization (`act_...`)
- ✅ Action stats and purchase value extraction
- ✅ 30-Day & lifetime performance payload aggregation in paise
- ✅ Automatic fallback to `FactAdsDaily` cached snapshot on expired token
