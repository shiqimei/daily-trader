# MANDATORY ACTIONS

- @src/tradingSystem/tradingSystem.md contains our core agent-based trading logic and strategies
- ALWAYS keep @src/tradingSystem/tradingSystem.md subjective, precise, and maintainable
- ALWAYS make minimal changes to @src/tradingSystem/tradingSystem.md

# How to write a good trading system?

1. Write Examples
2. Write decision trees to describe key logic
3. Write "Critical Discipline Rules (Zero Tolerance)"
   e.g.

   ```
   **FORBIDDEN ACTIONS (AUTOMATIC VIOLATION)**:
   1. **NEVER trade without 4+ star signal**
   2. **NEVER ignore 4H trend direction (must be UP/DOWN)**
   3. **NEVER enter when not AT key level**
   4. **NEVER skip TP1/TP2 order placement**
   5. **NEVER violate time-based exits (5min/30min/1hr)**
   6. **NEVER hold past 1hr without 80% exit**
   7. **NEVER trade SIDEWAYS markets**

   **MANDATORY ACTIONS (ZERO TOLERANCE)**:
   1. **ALWAYS place TP1 & TP2 orders before any analysis**
   2. **ALWAYS set phone timers (5m/30m/1hr)**
   3. **ALWAYS exit 50% if no movement in 5min**
   4. **ALWAYS exit 50% if <1R at 30min**
   5. **ALWAYS exit 80% at 1hr regardless of P/L**
   6. **ALWAYS log violations in memo**
   ```

4. Write "Execution Checklist (Use Every Time)"
5. Write "Risk/Reward: Minimum 2:1" trading system
