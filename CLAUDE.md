# MANDATORY ACTIONS

- @src/tradingSystem/tradingSystem.md contains our core agent-based trading logic and strategies
- ALWAYS keep @src/tradingSystem/tradingSystem.md subjective, precise, and maintainable
- ALWAYS make minimal changes to @src/tradingSystem/tradingSystem.md

# Lessons Learned

A successful stable profitable trading system consists of a couple of minor improvements accumulated.

- Use tradingSystem.md as core trading system for flexibility
- Focus on ETHUSDC, DO NOT TOUCH altcoin
- Focus on 30m timeframe + 5m timeframe
- TP/SL should be minimum 2:1, and ATR should be used to set TP/SL
- Move SL to BE after TP1 reached
- Use market order for entry and TP to save commission fee
- Use Claude Code ultrathink mode
- Use chrome mcp server and its `get_symbol_screenshot_across_timeframes`
- Use tradingJournal mcp server for journal pattern, self-reflection and improvement
- Reduce the frequency of bad trades rather than just managing them better
