import { MetaMaskSDK } from '@metamask/sdk';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import goldWindowAbi from '../../contracts/abi/GoldWindow.json' with { type: 'json' };
import testUsdAbi from '../../contracts/abi/TestUSD.json' with { type: 'json' };
import provedGoldAbi from '../../contracts/abi/ProvedGold.json' with { type: 'json' };

type AgreementStatus = 'offered' | 'collateral_locked' | 'funded' | 'released' | 'defaulted';

type AttestedChain = { role: string; name: string; chainKey: number; emitter: string | null; attestedHeight: number | null };

type DashboardPayload = {
  mode: 'read-only' | 'proving';
  custody: string;
  creditcoin: { network: string; chainId: number; explorerUrl: string; currency: { symbol: string; decimals: number } };
  attestcoin: { proofBuilderUrl: string; blockProverPrecompile: string; chains: AttestedChain[] };
  goldFeed: { description: string; aggregator: string; decimals: number; chainKey: number };
  goldPrice: { answer: string; roundId: number; updatedAt: string; stale: boolean } | null;
  market: { window: string | null; usd: string | null; gold: string | null; midUsdPerGram: string | null; buyUsdPerGram: string | null; sellUsdPerGram: string | null; goldInventory: string | null; usdInventory: string | null; spreadBps: number | null } | null;
  contracts: { ascRepoDesk: string | null; collateralRegistry: string | null };
  agreements: Array<{ id: string; status: AgreementStatus; principal: string; principalUsd: string; repaid: string; requiredRepayment: string; maturityAt: string; marginCalled: boolean; collateralValueUsd?: string; ltvBps?: number }>;
  proofs: Array<{ id: string; kind: string; status: string; sourceTxHash: string; creditcoinTxHash?: string; observedAt: string }>;
};

const root = document;
const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
const alertBox = root.querySelector<HTMLElement>('#dashboard-alert')!;
let snapshot: DashboardPayload | null = null;
let walletAccount = '';
let walletChain = '';

function showMessage(message: string) {
  alertBox.querySelector('p')!.textContent = message;
  alertBox.hidden = false;
}

const pages: Record<string, { label: string; meta: string }> = {
  overview: { label: 'Overview', meta: 'Agreements, proved price and pipeline health' },
  attest: { label: 'Attestcoin protocol', meta: 'Attested sources, proof builder and block prover' },
  lifecycle: { label: 'Repo lifecycle', meta: 'Pledges, drawn principal and settlement' },
  proofs: { label: 'Proof queue', meta: 'Source-chain events on their way to Creditcoin' }
};

function activateTab(name: string) {
  const page = pages[name];
  if (page) {
    root.querySelector('#page-label')!.textContent = page.label;
    root.querySelector('#page-meta')!.textContent = page.meta;
  }
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  panels.forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
}

tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab!)));
root.querySelectorAll<HTMLElement>('[data-open-tab]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  activateTab(link.dataset.openTab!);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));
alertBox.querySelector('button')!.addEventListener('click', () => { alertBox.hidden = true; });

async function getDashboard() {
  const response = await fetch('/api/dashboard', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return await response.json() as DashboardPayload;
}

function setText(selector: string, value: string | number) {
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => { element.textContent = String(value); });
}

function countByStatus(payload: DashboardPayload, statuses: AgreementStatus[]) {
  return payload.agreements.filter((agreement) => statuses.includes(agreement.status)).length;
}

function shortHash(value: string) { return `${value.slice(0, 10)}…${value.slice(-6)}`; }

function usd(value: string, decimals: number) {
  const scaled = Number(BigInt(value)) / 10 ** decimals;
  return scaled.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function render(payload: DashboardPayload) {
  snapshot = payload;
  const confirmed = payload.proofs.filter((proof) => proof.status === 'confirmed').length;
  const marginCalled = payload.agreements.filter((agreement) => agreement.marginCalled).length;

  setText('[data-metric="agreements"]', payload.agreements.length);
  setText('[data-metric="spot"]', payload.goldPrice ? usd(payload.goldPrice.answer, payload.goldFeed.decimals) : '—');
  setText('[data-metric="spot-round"]', payload.goldPrice ? `round ${payload.goldPrice.roundId}${payload.goldPrice.stale ? ' · stale' : ''}` : 'no round proved yet');
  setText('[data-metric="proofs"]', confirmed);
  setText('[data-metric="margin"]', marginCalled);
  setText('[data-count="locked"]', countByStatus(payload, ['collateral_locked']));
  setText('[data-count="funded"]', countByStatus(payload, ['funded']));
  setText('[data-count="closed"]', countByStatus(payload, ['released', 'defaulted']));
  root.querySelector('#sync-status')!.innerHTML = '<i></i> API connected';

  const facts = root.querySelector('#header-facts');
  if (facts) {
    const collateral = payload.attestcoin.chains.find((chain) => chain.role === 'collateral');
    const rows = [
      { label: 'NETWORK', value: `${payload.creditcoin.network} · ${payload.creditcoin.chainId}` },
      { label: 'ASC REPO DESK', value: payload.contracts.ascRepoDesk, link: payload.contracts.ascRepoDesk ? `${payload.creditcoin.explorerUrl}/address/${payload.contracts.ascRepoDesk}` : null },
      { label: 'COLLATERAL REGISTRY', value: payload.contracts.collateralRegistry, link: payload.contracts.collateralRegistry ? `https://sepolia.etherscan.io/address/${payload.contracts.collateralRegistry}` : null },
      { label: 'XAU / USD', value: payload.goldPrice ? `${usd(payload.goldPrice.answer, payload.goldFeed.decimals)} · round ${payload.goldPrice.roundId}` : null },
      { label: 'ATTESTED SOURCE', value: collateral?.attestedHeight ? `${collateral.name} ${collateral.attestedHeight}` : null },
      { label: 'PROOF WORKER', value: payload.mode === 'proving' ? 'Proving' : 'Read-only' }
    ];
    facts.innerHTML = rows.map((row) => {
      const shown = row.value ? (row.value.startsWith('0x') ? shortHash(row.value) : row.value) : 'not configured';
      const body = row.link ? `<a href="${row.link}" target="_blank" rel="noreferrer">${escapeHtml(shown)} ↗</a>` : escapeHtml(shown);
      return `<div class="header-fact${row.value ? '' : ' muted'}"><span>${row.label}</span><strong>${body}</strong></div>`;
    }).join('');
  }

  const market = payload.market;
  const money = (value: string | null, unit = '') => (value ? `$${Number(formatUnits(value, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}` : '—');
  setText('#window-mid', market?.midUsdPerGram ? `${money(market.midUsdPerGram)} / g` : 'window closed');
  setText('#window-quote', market?.buyUsdPerGram ? `${money(market.buyUsdPerGram)} / ${money(market.sellUsdPerGram)}` : '—');
  setText('#window-inventory', market?.goldInventory
    ? `${Number(formatUnits(market.goldInventory, 18)).toLocaleString('en-US')} g · ${money(market.usdInventory)}`
    : 'not funded');
  quotePerGram = market?.buyUsdPerGram ?? null;
  sellPerGram = market?.sellUsdPerGram ?? null;
  updateTradePreview();

  const chainLines = root.querySelector('#chain-lines');
  if (chainLines) {
    chainLines.innerHTML = payload.attestcoin.chains.map((chain) => `<div class="readiness-line"><span><i class="ready-dot"></i> ${escapeHtml(chain.name)} · key ${chain.chainKey}</span><strong>${chain.attestedHeight ?? '—'}</strong></div>`).join('');
  }

  const path = root.querySelector('#proof-path')!;
  const steps = payload.attestcoin.chains.map((chain) => ({
    label: `${chain.role.toUpperCase()} · CHAIN KEY ${chain.chainKey}`,
    title: chain.name,
    body: chain.role === 'price'
      ? `${payload.goldFeed.description} rounds, proved from the chain that hosts the feed. The aggregator emits AnswerUpdated; the proxy emits nothing.`
      : 'Allocated gold escrowed here. The registry emits one unambiguous event per custody action.',
    foot: chain.emitter ? shortHash(chain.emitter) : 'not deployed'
  }));
  steps.push(
    { label: 'PROOF BUILDER', title: 'Inclusion + continuity', body: 'A Merkle proof bound to an attested block, retrieved once attestors cover the height.', foot: new URL(payload.attestcoin.proofBuilderUrl).host },
    { label: 'BLOCK PROVER', title: 'Verified on Creditcoin', body: 'The precompile verifies each proof synchronously, inside the transaction that acts on it.', foot: shortHash(payload.attestcoin.blockProverPrecompile) }
  );
  path.innerHTML = steps.map((step) => `<article class="surface asset-card"><span class="eyebrow">${escapeHtml(step.label)}</span><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.body)}</p><footer><span>${escapeHtml(step.foot)}</span><span>Step ↗</span></footer></article>`).join('');

  const activity = root.querySelector('#activity-list')!;
  const events = payload.proofs.slice(0, 5).map((proof) => `${proof.kind.replace(/_/g, ' ')} · ${proof.status.replace(/_/g, ' ')}`);
  activity.innerHTML = events.length
    ? events.map((event, index) => `<div class="activity-row"><span>${escapeHtml(event)}</span><span>${index === 0 ? 'Latest' : 'Recorded'}</span></div>`).join('')
    : '<div class="loading-row">No proofs yet. Pledge bullion or prove a gold round to begin.</div>';

  const table = root.querySelector('#proof-table')!;
  root.querySelector('#queue-count')!.textContent = `${payload.proofs.length} proof${payload.proofs.length === 1 ? '' : 's'}`;
  table.innerHTML = payload.proofs.length
    ? payload.proofs.map((proof) => `<tr><td>${escapeHtml(shortHash(proof.sourceTxHash))}</td><td>${escapeHtml(proof.kind.replace(/_/g, ' '))}</td><td class="intent-status">${escapeHtml(proof.status.replace(/_/g, ' '))}</td><td>${new Date(proof.observedAt).toLocaleString()}</td></tr>`).join('')
    : '<tr><td colspan="4" class="loading-row">No source-chain events observed yet.</td></tr>';
}

function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }

async function refresh() {
  try { render(await getDashboard()); }
  catch (error) { root.querySelector('#sync-status')!.innerHTML = '<i style="background:#c56a69"></i> API unavailable'; showMessage(`${error instanceof Error ? error.message : 'Could not reach the MEU API'}. Start the Hono server on port 3000.`); }
}

root.querySelectorAll<HTMLButtonElement>('[data-refresh]').forEach((button) => button.addEventListener('click', refresh));

const sdk = new MetaMaskSDK({ dappMetadata: { name: 'MEU Exchange', url: window.location.origin } });
const walletButton = root.querySelector<HTMLButtonElement>('#wallet-connect')!;
const walletDialog = root.querySelector<HTMLElement>('#wallet-dialog')!;
const walletDialogButton = root.querySelector<HTMLButtonElement>('#wallet-dialog-connect')!;
const walletCopy = root.querySelector('#wallet-dialog-copy')!;
function shortAccount(account: string) { return `${account.slice(0, 6)}…${account.slice(-4)}`; }
function updateWallet() {
  setText('#wallet-state', walletAccount ? `${shortAccount(walletAccount)}${walletChain ? ` · ${walletChain}` : ''}` : 'Wallet not connected');
  walletButton.querySelector('span:last-child')!.textContent = walletAccount ? shortAccount(walletAccount) : 'Connect wallet';
}
async function connectWallet() {
  walletDialogButton.disabled = true;
  walletCopy.textContent = 'Waiting for approval in MetaMask…';
  try {
    const accounts = await sdk.connect();
    walletAccount = accounts[0] || '';
    const provider = sdk.getProvider();
    if (provider) walletChain = String(await provider.request({ method: 'eth_chainId' }));
    walletDialog.hidden = true;
    updateWallet();
  } catch (error) {
    walletCopy.textContent = error instanceof Error ? error.message : 'MetaMask connection was cancelled.';
  } finally { walletDialogButton.disabled = false; }
}
walletButton.addEventListener('click', () => { walletDialog.hidden = false; walletDialogButton.focus(); });
walletDialogButton.addEventListener('click', connectWallet);
root.querySelector('[data-close-wallet]')!.addEventListener('click', () => { walletDialog.hidden = true; });
walletDialog.addEventListener('click', (event) => { if (event.target === walletDialog) walletDialog.hidden = true; });

let quotePerGram: string | null = null;
let sellPerGram: string | null = null;

function gramsInput() {
  return Number((root.querySelector('#trade-grams') as HTMLInputElement | null)?.value ?? '0');
}

function updateTradePreview() {
  const grams = gramsInput();
  const target = root.querySelector('#trade-preview');
  if (!target) return;
  if (!quotePerGram || !sellPerGram || !Number.isFinite(grams) || grams <= 0) {
    target.textContent = '—';
    return;
  }
  const buy = (Number(formatUnits(quotePerGram, 6)) * grams).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sell = (Number(formatUnits(sellPerGram, 6)) * grams).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  target.textContent = `$${buy}  /  $${sell}`;
}

root.querySelector('#trade-grams')?.addEventListener('input', updateTradePreview);

async function trade(side: 'buy' | 'sell') {
  const market = snapshot?.market;
  if (!market?.window) throw new Error('The dealing window is not configured');
  if (!walletAccount) throw new Error('Connect a wallet to trade');
  const grams = gramsInput();
  if (!Number.isFinite(grams) || grams <= 0) throw new Error('Enter a positive number of grams');

  const eip1193 = sdk.getProvider();
  if (!eip1193) throw new Error('No wallet provider available');
  const signer = await new BrowserProvider(eip1193 as never).getSigner();
  const amount = parseUnits(String(grams), 18);
  const win = new Contract(market.window, goldWindowAbi as never, signer);

  if (side === 'buy') {
    const [buyUsd] = await win.quote(amount);
    const usd = new Contract(market.usd!, testUsdAbi as never, signer);
    await (await usd.approve(market.window, buyUsd)).wait();
    const tx = await win.buy(amount);
    showMessage(`Buy submitted at the proved round: ${tx.hash}`);
    await tx.wait();
  } else {
    const gold = new Contract(market.gold!, provedGoldAbi as never, signer);
    await (await gold.approve(market.window, amount)).wait();
    const tx = await win.sell(amount);
    showMessage(`Sell submitted at the proved round: ${tx.hash}`);
    await tx.wait();
  }
  await refresh();
}

for (const side of ['buy', 'sell'] as const) {
  root.querySelector(`#trade-${side}`)?.addEventListener('click', async () => {
    const button = root.querySelector<HTMLButtonElement>(`#trade-${side}`)!;
    button.disabled = true;
    try { await trade(side); }
    catch (error) { showMessage(error instanceof Error ? error.message : `Could not ${side} gold`); }
    finally { button.disabled = false; }
  });
}

function randomAgreementId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

root.querySelector('#prepare-terms')!.addEventListener('click', async () => {
  const button = root.querySelector<HTMLButtonElement>('#prepare-terms')!;
  button.disabled = true;
  try {
    if (!walletAccount) throw new Error('Connect a wallet first: the lender address is taken from it');
    const decimals = snapshot?.creditcoin.currency.decimals ?? 18;
    const ctc = Number((root.querySelector('#terms-principal') as HTMLInputElement).value);
    const usdLine = Number((root.querySelector('#terms-usd') as HTMLInputElement).value);
    const principal = (BigInt(Math.round(ctc * 1e6)) * 10n ** BigInt(decimals)) / 1_000_000n;

    const response = await fetch('/api/agreements/terms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agreementId: randomAgreementId(),
        borrowerPayout: walletAccount,
        sourceBorrower: walletAccount,
        principal: principal.toString(),
        principalUsd: BigInt(Math.round(usdLine * 1e8)).toString(),
        requiredRepayment: principal.toString(),
        maturity: Math.floor(Date.now() / 1000) + 30 * 86_400
      })
    });
    const result = await response.json() as { error?: string; transaction?: { to: string; data: string; value: string } };
    if (!response.ok || !result.transaction) throw new Error(result.error || 'The API rejected the terms');

    showMessage('Terms call prepared. Sign it in your wallet to publish the agreement on Creditcoin; MEU broadcast nothing.');
    await refresh();
    activateTab('proofs');
  } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not prepare the terms call'); }
  finally { button.disabled = false; }
});

function mountChart() {
  if (!root.getElementById('tv-gold')) return;
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.innerHTML = JSON.stringify({
    symbol: 'OANDA:XAUUSD',
    interval: '60',
    theme: 'light',
    style: '2',
    locale: 'en',
    hide_top_toolbar: true,
    hide_legend: false,
    allow_symbol_change: false,
    save_image: false,
    autosize: true
  });
  root.getElementById('tv-gold')!.appendChild(script);
}

mountChart();
refresh();

export const dashboardReady = true;
