/**
 * General exponential backoff utility for retrying operations
 */
export class ExponentialBackoff {
  private attempts: Map<string, number> = new Map()
  private lastAttempts: Map<string, number> = new Map()
  
  constructor(
    private baseCooldownMs: number = 3000,
    private maxCooldownMs: number = 60000,
    private multiplier: number = 2
  ) {}
  
  /**
   * Check if an operation can be attempted based on backoff
   * @param operationKey Unique key for the operation
   * @returns true if operation can proceed, false if still in cooldown
   */
  canAttempt(operationKey: string): boolean {
    const now = Date.now()
    const lastAttempt = this.lastAttempts.get(operationKey) || 0
    const attemptCount = this.attempts.get(operationKey) || 0
    
    const currentCooldown = Math.min(
      this.baseCooldownMs * Math.pow(this.multiplier, attemptCount),
      this.maxCooldownMs
    )
    
    return now - lastAttempt >= currentCooldown
  }
  
  /**
   * Record a failed attempt for backoff calculation
   * @param operationKey Unique key for the operation
   * @returns Next retry time in seconds
   */
  recordFailure(operationKey: string): number {
    const now = Date.now()
    const currentAttempts = (this.attempts.get(operationKey) || 0) + 1
    
    this.attempts.set(operationKey, currentAttempts)
    this.lastAttempts.set(operationKey, now)
    
    const nextCooldown = Math.min(
      this.baseCooldownMs * Math.pow(this.multiplier, currentAttempts),
      this.maxCooldownMs
    )
    
    return nextCooldown / 1000 // Return in seconds
  }
  
  /**
   * Reset backoff for successful operation
   * @param operationKey Unique key for the operation
   */
  recordSuccess(operationKey: string): void {
    this.attempts.delete(operationKey)
    this.lastAttempts.delete(operationKey)
  }
  
  /**
   * Get current cooldown remaining for an operation
   * @param operationKey Unique key for the operation
   * @returns Remaining cooldown in milliseconds
   */
  getRemainingCooldown(operationKey: string): number {
    const now = Date.now()
    const lastAttempt = this.lastAttempts.get(operationKey) || 0
    const attemptCount = this.attempts.get(operationKey) || 0
    
    const currentCooldown = Math.min(
      this.baseCooldownMs * Math.pow(this.multiplier, attemptCount),
      this.maxCooldownMs
    )
    
    const elapsed = now - lastAttempt
    return Math.max(0, currentCooldown - elapsed)
  }
  
  /**
   * Clear all backoff data
   */
  reset(): void {
    this.attempts.clear()
    this.lastAttempts.clear()
  }
}