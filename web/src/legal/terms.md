# HODL — Terms and Conditions

**DRAFT — not yet reviewed by counsel. Bracketed items must be filled in before publishing.**

Last updated: [DATE]

## 1. Who we are and what these terms cover

These terms are an agreement between you and [OPERATOR LEGAL NAME], [ENTITY TYPE AND JURISDICTION] ("HODL", "we", "us"). They cover your use of the website at [DOMAIN], its API, and the HODL prize pot program on the Solana blockchain (together, the "Service").

The website asks you to accept these terms and the Privacy Policy before it connects your wallet. By ticking that box, or by otherwise using the Service, you agree to both. If you do not agree, do not use the Service.

## 2. Eligibility

You may use the Service only if all of the following are true:

- You are at least 18 years old, or the age of majority where you live if that is higher.
- You are not located in, resident in, or a citizen of a Restricted Territory (section 3).
- You are not on any sanctions list maintained by the United States, the United Kingdom, the European Union or the United Nations, and you are not acting for anyone who is.
- Taking part in a prize draw of this kind is lawful where you are. You are responsible for checking this.
- You are using your own wallet and your own funds.

## 3. Restricted Territories

The Service is not offered to, and must not be used by, anyone located in, resident in, or organised under the laws of:

- [United States of America and its territories]
- [United Kingdom]
- [Canada — Ontario / all provinces]
- [Australia]
- [France]
- [Netherlands]
- [Singapore]
- [Mainland China]
- Cuba, Iran, North Korea and Syria
- The Crimea, Donetsk and Luhansk regions of Ukraine
- [Russia and Belarus]
- Any other country or region subject to comprehensive sanctions, or where prize draws, lotteries or the use of digital assets in this way are prohibited

[The bracketed entries above are a starting list. Counsel must confirm the final list.]

We do not currently block access by location or detect VPN use. The absence of a technical block does not mean you are permitted to use the Service. You are responsible for complying with this section. You must not use a VPN, proxy or any other method to hide your location in order to use the Service.

We may introduce geographic blocking, wallet screening or identity checks at any time and without notice. If we reasonably believe you are in a Restricted Territory or otherwise ineligible, we may refuse or restrict your access to the website and API.

## 4. What the Service does

HODL runs prize pots for reward tokens. The first live pot is for wNEAR.

- **Entering.** You approve the HODL program as a delegate over the reward token in your wallet. A keeper then moves ("sweeps") approved tokens from your wallet into the pot for the current round. The program also accepts a direct deposit signed by your wallet; the website does not offer this.
- **Chance of winning.** Your weight in a round is the amount you contributed multiplied by the time remaining until the draw when it was contributed. Earlier contributions carry more weight. Your chance is your weight divided by the total weight.
- **Cutoff.** Contributions and removals stop a set period before each draw (currently about 10 minutes). Tokens arriving after the cutoff go into the next round.
- **The draw.** One winner per round is selected on-chain using a randomness value from a third-party oracle (Switchboard). The transactions that close a round and settle it can be submitted by anyone (section 6).
- **The split, on-chain.** When a round is settled, the program sends 95% of the pot to the winner, 4.5% to the reserve account and 0.5% to the treasury account. Rounding remainders go to the winner. These percentages are fixed in the program.
- **What happens to the reserve, off-chain.** We then move the reserve to a wallet we control. Our current practice is to use an amount equal to 4% of the pot to buy the tokens that earned the reward, and 0.5% to add liquidity. This step is carried out by us, is not enforced by the program, and may change.
- **Your contribution is your ticket.** If you do not win, you do not get your contribution back. You can lose everything you contribute.
- **No withdrawal during a round.** Once tokens are in a pot you cannot take them out. The "Remove" control in the interface does not currently withdraw funds.
- **Cancelled rounds.** If we cancel a round, each contributor can claim back the amount they contributed to that round.
- **Limits.** Each round has a maximum per wallet, a maximum total, and a maximum number of contributing wallets. A contribution that would exceed a limit is not accepted.

Figures shown for Clash, Global Prize and similar features are for display only unless and until those features are launched.

## 5. Token approvals

- An approval lets the program move the approved token from your wallet up to the amount you approve, in any current or future round, until you revoke it or it is used up.
- **If you do not set a specific amount, the approval is unlimited.** It then covers all of that token in your wallet, including tokens you receive later and tokens that are not rewards.
- Anyone can submit the transaction that sweeps your approved tokens into the current round. It does not have to be us.
- You can revoke an approval at any time using the Revoke button or your wallet. Revoking stops future sweeps. It does not return tokens already in a pot.

We recommend approving only the amount you intend to contribute.

## 6. Who can do what on-chain

The program is not fully decentralised. An administrator key controlled by us can:

- pause new rounds and new contributions;
- cancel a round before it is settled;
- move tokens held in program accounts, including pot accounts;
- close program accounts;
- upgrade the program's code.

You are trusting us to use these powers properly. They also mean that a compromise of the administrator key could result in loss of tokens in the pots and of tokens covered by outstanding approvals.

Some actions need no special key. Any Solana account that pays the transaction fee can:

- open the next round when none is open, and set its draw time;
- close a round after its cutoff and choose the Switchboard randomness account used for its draw;
- settle a round after its draw time;
- sweep tokens that a wallet has approved into the current round;
- move the reserve account's balance to our reserve wallet.

We normally submit these transactions ourselves, but we are not the only party who can, and we do not control when or how others do.

## 7. Risks

By using the Service you accept these risks:

- **Experimental software.** The program is new and may contain errors or vulnerabilities, including ones that affect how winners are chosen or that allow funds to be lost or stuck.
- **Loss of contribution.** Most participants in each round lose their whole contribution.
- **Blockchain risk.** Transactions are irreversible. Network congestion, outages or forks may delay or prevent draws, sweeps, refunds and payouts.
- **Third parties.** The Service depends on Solana, Switchboard, your wallet provider, RPC providers and token issuers and bridges. We do not control them. A failure of any of them can delay a draw or cause loss.
- **Token risk.** Reward tokens can lose value, lose their peg or backing, or become illiquid.
- **Displayed information.** Prices, dollar values, countdowns and percentages on the website are estimates. The on-chain state is what counts.
- **Regulatory risk.** Laws on digital assets and prize draws vary and change. The Service may be restricted or shut down as a result.
- **Tax.** You are responsible for any tax on your contributions and winnings.

## 8. Your responsibilities

You agree that you will not:

- use the Service from a Restricted Territory or on behalf of someone who is ineligible;
- use funds derived from unlawful activity;
- interfere with the Service, including by manipulating draws, filling rounds with nominal entries to exclude others, or exploiting bugs;
- overload, scrape or attack the website or API;
- misrepresent your identity, location or eligibility.

If you find a vulnerability, report it to [CONTACT EMAIL] and do not exploit it.

You are solely responsible for your wallet, keys and devices. We never hold your private keys and cannot recover them.

## 9. Fees

The 4.5% reserve and 0.5% treasury shares described in section 4 are taken from each settled pot. You also pay Solana network fees on your own transactions. The split is fixed in the program. Changing it requires a program upgrade (section 6), and we would update these terms first.

## 10. No advice

Nothing on the Service is financial, investment, legal or tax advice. The Service is not an investment product and offers no expected return.

## 11. Changes, suspension and ending the Service

We may change, pause or end the Service or any part of it at any time. If we end a pot while a round is unsettled, we will cancel that round so contributors can claim refunds, where the program allows it.

We may update these terms. The date at the top shows the latest version. Using the Service after a change means you accept the new terms.

## 12. Intellectual property

The website, its design and its content belong to us or our licensors. You may use them only to access the Service. Third-party names and tokens belong to their owners, and their appearance does not imply endorsement.

## 13. Disclaimers

The Service is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, express or implied, including fitness for a particular purpose, uninterrupted availability, and freedom from errors or vulnerabilities.

## 14. Limitation of liability

To the fullest extent the law allows:

- we are not liable for indirect, incidental, special, consequential or punitive loss, or for loss of profits, data or digital assets;
- we are not liable for loss caused by third-party services, blockchain failures, wallet compromise, your own error, or unauthorised use of your wallet;
- our total liability to you for all claims relating to the Service is limited to [AMOUNT, e.g. USD 100, or the value of your contributions in the 30 days before the claim].

Nothing in these terms excludes liability that cannot be excluded by law.

## 15. Indemnity

You will compensate us for losses and costs, including reasonable legal fees, arising from your breach of these terms or your unlawful use of the Service.

## 16. Governing law and disputes

These terms are governed by the laws of [JURISDICTION]. Disputes will be resolved by [COURTS OF JURISDICTION / ARBITRATION UNDER RULES, SEAT, LANGUAGE]. [To the extent the law allows, claims may be brought only on an individual basis and not as part of a class or representative action.]

## 17. General

- If any part of these terms is unenforceable, the rest remains in effect.
- If we do not enforce a term, that is not a waiver.
- You may not transfer your rights under these terms. We may transfer ours.
- These terms and the Privacy Policy are the whole agreement between you and us about the Service.

## 18. Contact

[OPERATOR LEGAL NAME]
[ADDRESS]
[CONTACT EMAIL]
