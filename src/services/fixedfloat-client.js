import { createHmac } from 'node:crypto';
import { fromBaseUnits } from '../utils/amounts.js';
import { decimalToAtomic } from './changenow-client.js';
import { transactionExplorerUrl } from './transaction-explorer.js';
const NETWORKS = { btc:'BTC',ltc:'LTC',eth:'ETH',bsc:'BSC',sol:'SOL',doge:'DOGE' };
const NATIVE = { btc:'BTC',ltc:'LTC',eth:'ETH',bsc:'BNB',sol:'SOL',doge:'DOGE' };
const STATUS = { NEW:'PENDING_DEPOSIT', PENDING:'KNOWN_DEPOSIT_TX', EXCHANGE:'PROCESSING', WITHDRAW:'PROCESSING', DONE:'SUCCESS', EXPIRED:'PROCESSING', EMERGENCY:'PROCESSING' };
export class FixedFloatError extends Error {
  constructor(code, message, status=null) { super(message);this.name='FixedFloatError';this.code=code;this.status=status; }
}
function invalid() { throw new FixedFloatError('FIXEDFLOAT_INVALID_RESPONSE','FixedFloat returned inconsistent swap details. No new deposit instructions can be shown.'); }
function atomic(value,decimals) { try { return decimalToAtomic(value,decimals); } catch { invalid(); } }
function providerNormalizedAtomic(value,requested,decimals) {
  const actual=atomic(value,decimals);
  if(actual===requested)return actual;
  const match=/^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value));
  const precision=match?.[1]?.length??0;
  if(!match||precision>=decimals||BigInt(actual)<=0n||BigInt(actual)>BigInt(requested))invalid();
  const unit=10n**BigInt(decimals-precision);
  if((BigInt(requested)/unit)*unit!==BigInt(actual))invalid();
  return actual;
}
function safe(value) { return typeof value === 'string' && value.length > 0 && value.length < 250 && !/[\s`<>]/u.test(value) && ![...value].some(char=>char.codePointAt(0)<32); }
function usd(value,price) { const n=Number(value)*Number(price);return Number.isFinite(n)&&n>0?n.toFixed(8):null; }
export function matchFixedFloatAsset(asset, currencies, side) {
  const matches=currencies.filter(coin=>NETWORKS[asset.blockchain] && coin.network===NETWORKS[asset.blockchain] && coin.coin===asset.symbol && (coin[side]===true || coin[side]===1)
    && (asset.contractAddress ? typeof coin.contract==='string' && (['eth','bsc'].includes(asset.blockchain) ? coin.contract.toLowerCase()===asset.contractAddress.toLowerCase() : coin.contract===asset.contractAddress)
      : !coin.contract && coin.coin===NATIVE[asset.blockchain]));
  return matches.length===1?matches[0]:null;
}
export class FixedFloatClient {
  constructor(config,{fetchImpl=globalThis.fetch}={}) {this.config=config;this.fetch=fetchImpl;}
  get enabled() {return Boolean(this.config.fixedFloatApiKey&&this.config.fixedFloatApiSecret);}
  async request(method,params={}) {
    if(!this.enabled) throw new FixedFloatError('FIXEDFLOAT_UNAVAILABLE','The FixedFloat backup is not configured yet. You can request a route notification.');
    const body=JSON.stringify(params);
    let response,payload;
    try {response=await this.fetch('https://ff.io/api/v2/'+method,{method:'POST',body,redirect:'error',signal:globalThis.AbortSignal.timeout(15000),headers:{'Content-Type':'application/json; charset=UTF-8','X-API-KEY':this.config.fixedFloatApiKey,'X-API-SIGN':createHmac('sha256',this.config.fixedFloatApiSecret).update(body).digest('hex')}});payload=await response.json().catch(()=>null);}
    catch {throw new FixedFloatError('FIXEDFLOAT_UNAVAILABLE','FixedFloat did not respond. Please try again later.');}
    if(!response.ok) throw new FixedFloatError([401,403].includes(response.status)?'FIXEDFLOAT_AUTHENTICATION':'FIXEDFLOAT_UNAVAILABLE','FixedFloat is temporarily unavailable.',response.status);
    if(payload?.code!==0) throw new FixedFloatError('FIXEDFLOAT_REQUEST_REJECTED','FixedFloat rejected this request. Check the amount and receiving address or try later.');
    if(!payload.data||typeof payload.data!=='object')invalid();return payload.data;
  }
  async canQuote({originAsset,destinationAsset,amountBase}) {
    return Boolean(await this.getIndicativeQuote({originAsset,destinationAsset,amountBase}));
  }
  async getIndicativeQuote({originAsset,destinationAsset,amountBase}) {
    if(!this.enabled)return false;
    const currencies=await this.request('ccies');if(!Array.isArray(currencies))invalid();
    const from=matchFixedFloatAsset(originAsset,currencies,'recv'),to=matchFixedFloatAsset(destinationAsset,currencies,'send');
    if(!from||!to||to.tag)return null;
    const amount=fromBaseUnits(amountBase,originAsset.decimals);
    const price=await this.request('price',{fromCcy:from.code,toCcy:to.code,amount,direction:'from',type:'float'});
    if(!Array.isArray(price.errors))invalid();
    if(price.errors.length)return null;
    const data={fromCode:from.code,toCode:to.code,fromNetwork:from.network,toNetwork:to.network,fromCoin:from.coin,toCoin:to.coin};
    validatePair(price,data);
    if(atomic(price.from.amount,originAsset.decimals)!==amountBase)return null;
    const amountOut=atomic(price.to.amount,destinationAsset.decimals);
    if(BigInt(amountOut)<=0n)return null;
    return {
      amountInUsd:usd(amount,originAsset.price),
      providerUsd: { amountInUsd: price.from.usd, amountOutUsd: price.to.usd },
      amountOut,
      amountOutFormatted:fromBaseUnits(amountOut,destinationAsset.decimals),
      amountOutUsd:usd(price.to.amount,destinationAsset.price),
    };
  }
  async getQuote({dry,originAsset,destinationAsset,amountBase,recipient,refundTo,backupConsent}) {
    if(backupConsent!==true)throw new FixedFloatError('FIXEDFLOAT_CONSENT_REQUIRED','Choose the FixedFloat backup and review its live quote before continuing.');
    const currencies=await this.request('ccies');if(!Array.isArray(currencies))invalid();
    const from=matchFixedFloatAsset(originAsset,currencies,'recv'),to=matchFixedFloatAsset(destinationAsset,currencies,'send');
    if(!from||!to)throw new FixedFloatError('NO_LIQUIDITY_ROUTE','FixedFloat does not support this exact asset and network pair.');
    if(to.tag)throw new FixedFloatError('FIXEDFLOAT_TAG_REQUIRED','This backup destination requires a memo/tag and is not supported by this flow.');
    if(!safe(recipient)||!safe(refundTo))throw new FixedFloatError('INVALID_WALLET_ADDRESS','Check the receiving and refund addresses.');
    const amount=fromBaseUnits(amountBase,originAsset.decimals);
    const request={fromCcy:from.code,toCcy:to.code,amount,direction:'from',type:'float'};
    const price=await this.request('price',request);
    if(!Array.isArray(price.errors))invalid();
    if(price.errors.length){const code=price.errors.includes('LIMIT_MIN')?'AMOUNT_TOO_LOW':price.errors.includes('LIMIT_MAX')?'AMOUNT_TOO_HIGH':price.errors.every(x=>/^(MAINTENANCE|OFFLINE|RESERVE)_(FROM|TO)$/.test(x))?'NO_LIQUIDITY_ROUTE':'FIXEDFLOAT_REQUEST_REJECTED';throw new FixedFloatError(code,'FixedFloat has no available quote for this amount. Try another amount or request a notification.');}
    const data={fromCode:from.code,toCode:to.code,fromNetwork:from.network,toNetwork:to.network,fromCoin:from.coin,toCoin:to.coin,originDecimals:originAsset.decimals,destinationDecimals:destinationAsset.decimals,originChain:originAsset.blockchain,destinationChain:destinationAsset.blockchain,originPrice:originAsset.price,destinationPrice:destinationAsset.price};
    validatePair(price,data);if(atomic(price.from.amount,originAsset.decimals)!==amountBase)invalid();
    const amountOut=atomic(price.to.amount,destinationAsset.decimals);if(BigInt(amountOut)<=0n)invalid();
    const deadline=new Date(Date.now()+this.config.fundingDeadlineMs).toISOString();
    const quote={provider:'fixedfloat',providerData:data,quoteRequest:{dry,originAsset:originAsset.assetId,destinationAsset:destinationAsset.assetId,amount:amountBase,recipient,refundTo,deadline,appFees:[],backupConsent:true},quote:{providerUsd:{amountInUsd:price.from.usd,amountOutUsd:price.to.usd},amountIn:amountBase,amountInFormatted:amount,amountOut,amountOutFormatted:fromBaseUnits(amountOut,destinationAsset.decimals),amountInUsd:usd(amount,originAsset.price),amountOutUsd:usd(price.to.amount,destinationAsset.price),deadline,floating:true,minAmountOut:null}};
    if(dry)return quote;
    // Never retry create or automatically choose an emergency exchange/refund.
    const order=await this.request('create',{...request,toAddress:recipient});
    validatePair(order,data);
    if(order.type!=='float'||order.status!=='NEW'||!/^[A-Za-z0-9]{6}$/.test(order.id??'')||!safe(order.token)||!safe(order.from.address)||order.to.address!==recipient||order.to.tag)invalid();
    const actualAmountIn=providerNormalizedAtomic(order.from.amount,amountBase,originAsset.decimals);
    if(order.from.tag&&!safe(order.from.tag))invalid();
    const expires=Number(order.time?.expiration)*1000;if(!Number.isFinite(expires)||expires<=Date.now())invalid();
    data.exchangeId=order.id;data.token=order.token;
    Object.assign(quote.quote,{providerUsd:Number(order.from.usd)>0&&Number(order.to.usd)>0?{amountInUsd:order.from.usd,amountOutUsd:order.to.usd}:quote.quote.providerUsd,amountIn:actualAmountIn,amountInFormatted:fromBaseUnits(actualAmountIn,originAsset.decimals),amountInUsd:usd(order.from.amount,originAsset.price),depositAddress:order.from.address,depositMemo:order.from.tag||null,deadline:new Date(expires).toISOString(),amountOut:atomic(order.to.amount,destinationAsset.decimals),amountOutFormatted:fromBaseUnits(atomic(order.to.amount,destinationAsset.decimals),destinationAsset.decimals),amountOutUsd:usd(order.to.amount,destinationAsset.price)});
    quote.quoteRequest.amount=actualAmountIn;
    if(BigInt(quote.quote.amountOut)<=0n)invalid();quote.quoteRequest.deadline=quote.quote.deadline;return quote;
  }
  async chooseRecovery(swap, choice) {
    if (!['EXCHANGE', 'REFUND'].includes(choice)) invalid();
    const current = await this.getExecutionStatus(swap);
    if (current.providerStatus !== 'EMERGENCY' || current.emergency.choice !== 'NONE' || !current.emergency.reasons.includes('LESS') || current.emergency.repeat) {
      throw new FixedFloatError('FIXEDFLOAT_RECOVERY_UNAVAILABLE', 'This order cannot use this recovery choice now. Open the FixedFloat order for its current options.');
    }
    if (choice === 'EXCHANGE' && current.emergency.reasons.includes('LIMIT')) {
      throw new FixedFloatError('FIXEDFLOAT_RECOVERY_UNAVAILABLE', 'The deposit is outside FixedFloat exchange limits. Request a refund or open the order.');
    }
    const data = swap.executable_quote.providerData;
    if (choice === 'REFUND' && !safe(swap.refund_to)) invalid();
    // A financial choice is sent once, only after an explicit owner button click.
    return this.request('emergency', { id: data.exchangeId, token: data.token, choice,
      ...(choice === 'REFUND' ? { address: swap.refund_to } : {}) });
  }

  async getExecutionStatus(swap) {
    const data=swap.executable_quote?.providerData;if(swap.executable_quote?.provider!=='fixedfloat'||!data?.exchangeId||!data.token)invalid();
    const order=await this.request('order',{id:data.exchangeId,token:data.token});validatePair(order,data);
    if(order.id!==data.exchangeId||order.type!=='float'||order.from.address!==swap.deposit_address||order.to.address!==swap.recipient||(order.from.tag||null)!==(swap.deposit_memo||null)||order.to.tag)invalid();
    let status=STATUS[order.status];if(!status)invalid();
    if (order.status === 'EMERGENCY' && order.emergency?.status?.includes('LESS') && order.emergency?.choice === 'NONE') status = 'INCOMPLETE_DEPOSIT';
    const details={providerUsd:{amountInUsd:order.from.usd,amountOutUsd:order.to.usd}};
    for(const [side,chain,key] of [['from',data.originChain,'originChainTxHashes'],['to',data.destinationChain,'destinationChainTxHashes'],['back',data.originChain,'refundTxHashes']]){const hash=order[side]?.tx?.id;details[key]=safe(hash)?[{hash,explorerUrl:transactionExplorerUrl(chain,hash)??undefined}]:[];}
    if(order.from.tx?.amount){details.depositedAmount=atomic(order.from.tx.amount,data.originDecimals);details.amountInFormatted=fromBaseUnits(details.depositedAmount,data.originDecimals);details.amountInUsd=usd(details.amountInFormatted,data.originPrice);}
    if(order.to.tx?.amount){details.amountOut=atomic(order.to.tx.amount,data.destinationDecimals);details.amountOutFormatted=fromBaseUnits(details.amountOut,data.destinationDecimals);details.amountOutUsd=usd(details.amountOutFormatted,data.destinationPrice);}
    if(order.status==='DONE'&&order.emergency?.choice==='REFUND'){
      if(!details.refundTxHashes.length||order.back?.address!==swap.refund_to||order.back?.network!==data.fromNetwork||order.back?.code!==data.fromCode)invalid();status='REFUNDED';
    } else if(status==='SUCCESS'&&(!details.destinationChainTxHashes.length||!details.amountOut||BigInt(details.amountOut)<=0n))invalid();
    return {provider:'fixedfloat',providerStatus:order.status,emergency:normalizeEmergency(order.emergency),status,requiresAttention:['EMERGENCY','EXPIRED'].includes(order.status),updatedAt:new Date().toISOString(),swapDetails:details};
  }
}
function validatePair(value,data){for(const [side,prefix] of [['from','from'],['to','to']]){if(value[side]?.code!==data[prefix+'Code']||value[side]?.network!==data[prefix+'Network']||value[side]?.coin!==data[prefix+'Coin'])invalid();}}

function normalizeEmergency(value) {
  return { reasons: Array.isArray(value?.status) ? value.status.filter(x => typeof x === 'string') : [],
    choice: ['NONE', 'EXCHANGE', 'REFUND'].includes(value?.choice) ? value.choice : null,
    repeat: value?.repeat === true || value?.repeat === 1 };
}
