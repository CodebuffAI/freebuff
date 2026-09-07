/**
 * A generic min heap implementation that maintains elements ordered by a numeric score.
 */
export class MinHeap<T> {
  private heap: { item: T; score: number }[] = []

  private getParentIndex(index: number): number {
    if (!Number.isFinite(index)) return 0
    return Math.floor((index - 1) / 2)
  }

  private getLeftChildIndex(index: number): number {
    if (!Number.isFinite(index)) return 0
    return 2 * index + 1
  }

  private getRightChildIndex(index: number): number {
    if (!Number.isFinite(index)) return 0
    return 2 * index + 2
  }

  private swap(index1: number, index2: number): void {
    const temp = this.heap[index1]
    this.heap[index1] = this.heap[index2]
    this.heap[index2] = temp
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parentIndex = this.getParentIndex(index)
      if (this.heap[parentIndex].score <= this.heap[index].score) {
        break
      }
      this.swap(index, parentIndex)
      index = parentIndex
    }
  }

  private siftDown(index: number): void {
    while (true) {
      let minIndex = index
      const leftChild = this.getLeftChildIndex(index)
      const rightChild = this.getRightChildIndex(index)

      if (
        leftChild < this.heap.length &&
        this.heap[leftChild].score < this.heap[minIndex].score
      ) {
        minIndex = leftChild
      }

      if (
        rightChild < this.heap.length &&
        this.heap[rightChild].score < this.heap[minIndex].score
      ) {
        minIndex = rightChild
      }

      if (minIndex === index) {
        break
      }

      this.swap(index, minIndex)
      index = minIndex
    }
  }

  insert(item: T, score: number): void {
    this.heap.push({ item, score })
    this.siftUp(this.heap.length - 1)
  }

  extractMin(): T | undefined {
    if (this.heap.length === 0) return undefined

    const minItem = this.heap[0].item
    const last = this.heap.pop()!

    if (this.heap.length > 0) {
      this.heap[0] = last
      this.siftDown(0)
    }

    return minItem
  }

  get size(): number {
    return this.heap.length
  }
}
