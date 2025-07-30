export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private count: number = 0;
  
  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }
  
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  
  get length(): number {
    return this.count;
  }
  
  toArray(): T[] {
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    
    return result;
  }
  
  getLast(n: number): T[] {
    const arr = this.toArray();
    return arr.slice(-n);
  }
  
  getFirst(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = this.count < this.capacity ? 0 : this.head;
    return this.buffer[idx];
  }
  
  getLastItem(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }
  
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}