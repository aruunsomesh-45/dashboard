| Dashboard Page | Platform / Source | Metric Name | Mathematical Formula / Calculation | Storage Unit |
| --- | --- | --- | --- | --- |
| Overview (Home) | Shopify | Revenue / Day (Daily Net Sales) | ∑(Gross−Discounts−Refunds−Taxes)\\sum (\\text{Gross} - \\text{Discounts} - \\text{Refunds} - \\text{Taxes})∑(Gross−Discounts−Refunds−Taxes) per day | Paise (INR) |
| Overview (Home) | Meta Ads | Blended ROAS | ∑Attributed Revenue∑Meta Ad Spend\\frac{\\sum \\text{Attributed Revenue}}{\\sum \\text{Meta Ad Spend}}∑Meta Ad Spend∑Attributed Revenue​ (28-day restated) | Ratio (xxx) |
| Overview (Home) | Meta Ads | Blended CAC | ∑Ad Spend∑New Customers Acquired\\frac{\\sum \\text{Ad Spend}}{\\sum \\text{New Customers Acquired}}∑New Customers Acquired∑Ad Spend​ | Paise (INR) |
| Overview (Home) | Logistics (Delhivery) | Delivery Success % | Count(Delivered Shipments)Count(Total Shipments)×100\\frac{\\text{Count(Delivered Shipments)}}{\\text{Count(Total Shipments)}} \\times 100Count(Total Shipments)Count(Delivered Shipments)​×100 | Percentage (%) |
| Overview (Home) | Logistics (Delhivery) | Orders to be Shipped | Count(Orders where Paid and Unfulfilled)\\text{Count}(\\text{Orders where Paid and Unfulfilled})Count(Orders where Paid and Unfulfilled) | Count |
| Overview (Home) | Razorpay | Number of Disputes | Count(Dispute records where status is open/under_review)\\text{Count}(\\text{Dispute records where status is open/under\\_review})Count(Dispute records where status is open/under_review) | Count |
| Overview (Home) | Instagram | Organic Engagement | ∑(Likes+Comments+Saves)Followers Count×100\\frac{\\sum (\\text{Likes} + \\text{Comments} + \\text{Saves})}{\\text{Followers Count}} \\times 100Followers Count∑(Likes+Comments+Saves)​×100 | Percentage (%) |
| Shopify Store | Shopify | Average Order Value (AOV) | ∑Net Sales∑Eligible Orders\\frac{\\sum \\text{Net Sales}}{\\sum \\text{Eligible Orders}}∑Eligible Orders∑Net Sales​ (Ratio of Sums) | Paise (INR) |
| Shopify Store | Shopify | Gross Sales & Discounts | ∑Line Items Price\\sum \\text{Line Items Price}∑Line Items Price vs ∑Discount Codes\\sum \\text{Discount Codes}∑Discount Codes | Paise (INR) |
| Shopify Store | Shopify | Fulfillment Funnel | Count breakdown: Placed →\\rightarrow→ Paid →\\rightarrow→ Shipped →\\rightarrow→ Delivered | Count |
| Payments | Razorpay | Gateway Authorization Rate | Count(Captured Attempts)Count(Total Attempts)×100\\frac{\\text{Count(Captured Attempts)}}{\\text{Count(Total Attempts)}} \\times 100Count(Total Attempts)Count(Captured Attempts)​×100 | Percentage (%) |
| Payments | Razorpay | UPI Drop-Off Rate | Count(UPI Cancel / Timeout)Count(UPI Attempts)×100\\frac{\\text{Count(UPI Cancel / Timeout)}}{\\text{Count(UPI Attempts)}} \\times 100Count(UPI Attempts)Count(UPI Cancel / Timeout)​×100 | Percentage (%) |
| Payments | Razorpay | Refund Volume | ∑Refunded Payments\\sum \\text{Refunded Payments}∑Refunded Payments | Paise (INR) |
| Marketing & Ads | Meta Ads | Cost Per Click (CPC) | ∑Ad Spend∑Outbound Clicks\\frac{\\sum \\text{Ad Spend}}{\\sum \\text{Outbound Clicks}}∑Outbound Clicks∑Ad Spend​ | Paise (INR) |
| Marketing & Ads | Meta Ads | Click-Through Rate (CTR) | ∑Clicks∑Impressions×100\\frac{\\sum \\text{Clicks}}{\\sum \\text{Impressions}} \\times 100∑Impressions∑Clicks​×100 | Percentage (%) |
| Marketing & Ads | Instagram | Follower Growth Velocity | Followerstoday−Followersyesterday\\text{Followers}_{\\text{today}} - \\text{Followers}_{\\text{yesterday}}Followerstoday​−Followersyesterday​ | Count / Day |
| Logistics | Delhivery / Shiprocket | NDR (Non-Delivery) Rate | Count(Shipments with ≥1 NDR)Count(Total Dispatches)×100\\frac{\\text{Count(Shipments with } \\ge 1 \\text{ NDR)}}{\\text{Count(Total Dispatches)}} \\times 100Count(Total Dispatches)Count(Shipments with ≥1 NDR)​×100 | Percentage (%) |
| Logistics | Delhivery / Shiprocket | RTO (Return to Origin) % | Count(RTO Delivered)Count(Total Dispatches)×100\\frac{\\text{Count(RTO Delivered)}}{\\text{Count(Total Dispatches)}} \\times 100Count(Total Dispatches)Count(RTO Delivered)​×100 | Percentage (%) |
| Logistics | Delhivery / Shiprocket | Avg Transit Time | Avg(Delivered Timestamp−Pickup Timestamp)\\text{Avg}(\\text{Delivered Timestamp} - \\text{Pickup Timestamp})Avg(Delivered Timestamp−Pickup Timestamp) | Hours / Days |


Gross Merchandise Value (GMV / Gross Sales)
  − Discounts & Promos
  − Refunds & Cancellations
  − Taxes (GST Collected)
--------------------------------------------------
= 1. Net Revenue (Net Realized Sales)

  − Cost of Goods Sold (COGS: Product Base Cost)
--------------------------------------------------
= 2. Gross Margin (Gross Profit)

  − Paid Marketing Spend (Meta Ads & Retargeting)
  − Payment Gateway Charges (Razorpay 2% Fees + Dispute Penalties)
  − Shipping & Fulfillment Costs (Delhivery Forward + RTO Charges)
--------------------------------------------------
= 3. Contribution Margin 1 (CM1) / Operating Profit

  − Fixed Overhead (Software Subscriptions, Packaging, Salaries)
--------------------------------------------------
= 4. Net Bottom-Line Profit (EBITDA)



Where Each Line Item Comes From
1. Net Revenue (from Shopify)
Gross Sales: The total sticker price of all items added to carts and ordered.
Minus Discounts: Coupon codes, cart discounts, and gift cards redeemed.
Minus Refunds & Returns: Completed cancellations or refunded items.
Minus GST: Tax liability collected on behalf of the government.
Equals: True Net Revenue — the actual money the brand earned from sales.
2. Cost of Goods Sold / COGS (from Catalog Master)
Product Manufacturing / Procurement Cost: The landed cost to produce or buy the finished goods that were shipped in those orders.
Gross Profit: Net Revenue minus COGS. This reveals your core product markup before spending a single rupee on marketing or shipping.
3. Direct Operating Expenses (Variable Channel Costs)

Marketing & Acquisition Cost (from Meta Ads):

Total ad spend consumed across Advantage+, retargeting, and brand awareness campaigns.
Calculated directly through your ROAS and CAC (Ad Spend 
÷
÷ New Customers).

Payment Gateway & Dispute Costs (from Razorpay):

Standard transaction processing fee (typically 2% on domestic card/UPI transactions).
Chargeback or dispute penalty fees on contested transactions.

Logistics & Delivery Expenses (from Delhivery):

Forward Freight: Shipping fees paid for successful dispatches.
RTO (Return to Origin) Penalties: In Indian e-commerce, when Cash-on-Delivery (COD) or non-delivery attempts result in an RTO, you pay forward freight plus reverse freight without making any revenue.
Weight Discrepancy Surcharges: Any carrier adjustments on volumetric weight.
4. Contribution Margin (CM1) — The Health Score
Gross Profit minus (Ad Spend + Razorpay Fees + Delhivery Shipping Costs).
This is the single most critical figure for any D2C founder. If your Contribution Margin is positive, every extra order you ship puts real cash into the business. If it is negative, scaling your ads actually causes you to lose money faster.
5. Net Profit
Contribution Margin minus Fixed Operating Overheads (warehousing rent, agency retainers, software SaaS tools like Shopify/email marketing apps, packaging materials, and team payroll).
Equals: Your final Bottom-Line Net Profit.