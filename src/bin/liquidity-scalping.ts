/**
 * === liquidity scalping strategy v0.1.0 ===
 *
 * This is a self-contained liquidity scalping strategy cli program driven by dynamic orderbooks.
 * Our client is using standard mcp client that integrates mcpServers/binance.ts mcp server.
 * Internally, we have a state-machine to manage states and the current state.
 *
 * 1. We look for suitable markets that have proper Volatility (ATR) and Liquidity (Spread).
 *    Using `get_top_symbols` with 40bps <= atr_bps_5m <= 80bps sorted by atr_bps_5m aesc.
 * 2. If there's no active positions. It's entry-hunting mode - We choose the first market in the results
 *    and subscribe orderbook websocket events to look for entry opportunities (check OrderbookDynamics.ts):
 *      - If there's no marker order and spread spread_ticks > 1 (there's a spread gap):
 *          <> If there's bids LIQUIDITY_SURGE or asks LIQUIDITY_WITHDRAWAL, we create a long marker-only bids order just below best_ask;
 *          <> If there's asks LIQUIDITY_SURGE or bids LIQUIDITY_WITHDRAWAL, we create a short marker-only asks order just above best_bid.
 *          If marker-only order can't be placed, we wait for next chance.
 *      - If thre're an active marker order:
 *          <> If received any MARKET_MAKER_SHIFT event, cancel the order;
 *          <> If our active marker order is long, and LIQUIDITY_SURGE is asks or LIQUIDITY_WITHDRAWAL is bids, cancel the order;
 *          <> If our active marker order is short, and LIQUIDITY_SURGE is bids or LIQUIDITY_WITHDRAWAL is asks, cancel the order.
 * 3. Once a new position open:
 *      <> TP: we set TP to an atr_bps_5m above or below immediately. It should be a marker-only order.
 *      <> SL: we set SL to a half of an atr_bps_5m above or below immediately. It should be a market order.
 * 4. When we have an active position, keep monitoring the price:
 *      <> Move SL to BL once we have 5bps profit to cover the SL fees.
 *      <> When a position holds over 2 mins and we have 5+ bps, closed it using market order immediately to avoid risks.
 * 5. Loop above steps, if we are in entry-hunting mode, just to make sure we entry following rules listed above.
 *
 * Position Management:
 *  <> 30% Rule: Risk per trade never exceeds 30%, use calculate_position_size for position calculation
 *  <> TP/SL: Set immediately after entry, no exceptions
 *  <> R:R = ATR : 0.5ATR = 2:1
 *  <> Position Limit: Maximum 1 concurrent position
 */
