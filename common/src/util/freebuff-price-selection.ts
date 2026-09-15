/** A purchase's selected terms, independent of the latest displayed quote and
 * of expiring wallet permission. Identity distinguishes two identical choices. */
type PriceExpectation = Readonly<{
  firstTabDiscount: boolean
}>

export class FreebuffPriceSelection {
  private selected: PriceExpectation | undefined
  private owner: string | undefined

  get expectation(): PriceExpectation | undefined {
    return this.selected
  }

  choose(firstTabDiscount: boolean, owner?: string): PriceExpectation {
    this.owner = owner
    return (this.selected = { firstTabDiscount })
  }

  /** Retries capture the same choice; metadata refreshes never replace it.
   * An implicit admission uses the current quote when no choice is pending. */
  capture(firstTabDiscount: boolean, owner?: string): PriceExpectation {
    if (!this.selected || this.owner !== owner)
      return this.choose(firstTabDiscount, owner)
    return this.selected
  }

  purchased(expectation: PriceExpectation | undefined): void {
    if (this.selected === expectation) this.selected = undefined
  }
}
