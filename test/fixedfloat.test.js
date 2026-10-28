import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { FixedFloatClient, matchFixedFloatAsset } from '../src/services/fixedfloat-client.js';
import { quotedRouteCostPercentDisplay } from '../src/utils/amounts.js';
import { TicketService } from '../src/services/ticket-service.js';
const config={fixedFloatApiKey:'test-key',fixedFloatApiSecret:'test-secret',fundingDeadlineMs:3600000};
const origin={assetId:'ltc',symbol:'LTC',blockchain:'ltc',decimals:8,price:55};
const destination={assetId:'usdt-bsc',symbol:'USDT',blockchain:'bsc',decimals:18,contractAddress:'0x123',price:1};
const currencies=[{code:'LTC',coin:'LTC',network:'LTC',recv:true,send:true},{code:'USDTBSC',coin:'USDT',network:'BSC',contract:'0x123',recv:true,send:true}];
const params={dry:true,originAsset:origin,destinationAsset:destination,amountBase:'100000000',recipient:'recipient',refundTo:'refund',backupConsent:true};
const price={from:{code:'LTC',coin:'LTC',network:'LTC',amount:'1'},to:{code:'USDTBSC',coin:'USDT',network:'BSC',amount:'54'},errors:[]};
const order={...price,id:'ABC123',token:'private-order-token',type:'float',status:'NEW',time:{expiration:Math.floor(Date.now()/1000)+1800},from:{...price.from,address:'deposit',tag:null},to:{...price.to,address:'recipient',tag:null}};
function fixture(overrides={}){const fetchImpl=vi.fn(async(url,_options)=>{const method=url.split('/').at(-1);const data=overrides[method]??({ccies:currencies,price,create:order,order:{...order,status:'DONE',from:{...order.from,tx:{id:'deposit-hash',amount:'1'}},to:{...order.to,tx:{id:'payout-hash',amount:'53.8'}}}})[method];if(data instanceof Error)throw data;return {ok:true,status:200,json:async()=>({code:0,data})};});return {client:new FixedFloatClient(config,{fetchImpl}),fetchImpl};}
describe('FixedFloat backup',()=>{
it('accepts numeric availability flags from the live API and rejects zero',()=>{expect(matchFixedFloatAsset(origin,[{...currencies[0],recv:1}],'recv')).not.toBeNull();expect(matchFixedFloatAsset(origin,[{...currencies[0],recv:0}],'recv')).toBeNull();});
it('signs requests and does not create an order for a preview',async()=>{const {client,fetchImpl}=fixture();const q=await client.getQuote(params);expect(q).toMatchObject({provider:'fixedfloat',quote:{amountOutFormatted:'54',floating:true,minAmountOut:null},quoteRequest:{backupConsent:true,appFees:[]}});for(const [url,options] of fetchImpl.mock.calls){expect(options.headers['X-API-SIGN']).toBe(createHmac('sha256','test-secret').update(options.body).digest('hex'));expect(url).not.toContain('create');expect(JSON.parse(options.body)).not.toHaveProperty('afftax');}});
it('checks whether the exact amount is supported without creating an order',async()=>{const {client,fetchImpl}=fixture();expect(await client.canQuote(params)).toBe(true);expect(fetchImpl.mock.calls.map(([url])=>url.split('/').at(-1))).toEqual(['ccies','price']);});
it('returns the live quoted values used to calculate the displayed percentage',async()=>{const {client}=fixture();expect(await client.getIndicativeQuote(params)).toMatchObject({amountInUsd:'55.00000000',amountOutUsd:'54.00000000',amountOutFormatted:'54'});});
it('accepts only deterministic provider precision truncation and displays the exact deposit amount',async()=>{const sol={...origin,symbol:'SOL',blockchain:'sol',decimals:9};const solCurrencies=[{code:'SOL',coin:'SOL',network:'SOL',recv:true,send:true},currencies[1]];const solPrice={...price,from:{code:'SOL',coin:'SOL',network:'SOL',amount:0.136228182}};const solOrder={...order,from:{...order.from,code:'SOL',coin:'SOL',network:'SOL',amount:'0.13622818'}};const {client}=fixture({ccies:solCurrencies,price:solPrice,create:solOrder});const q=await client.getQuote({...params,dry:false,originAsset:sol,amountBase:'136228182'});expect(q.quote).toMatchObject({amountIn:'136228180',amountInFormatted:'0.13622818'});expect(q.quoteRequest.amount).toBe('136228180');});
it('rejects provider input amounts that are not the exact lower-precision truncation',async()=>{const sol={...origin,symbol:'SOL',blockchain:'sol',decimals:9};const solCurrencies=[{code:'SOL',coin:'SOL',network:'SOL',recv:true,send:true},currencies[1]];const solPrice={...price,from:{code:'SOL',coin:'SOL',network:'SOL',amount:0.136228182}};for(const amount of ['0.13622817','0.13622819']){const solOrder={...order,from:{...order.from,code:'SOL',coin:'SOL',network:'SOL',amount}};const {client}=fixture({ccies:solCurrencies,price:solPrice,create:solOrder});await expect(client.getQuote({...params,dry:false,originAsset:sol,amountBase:'136228182'})).rejects.toMatchObject({code:'FIXEDFLOAT_INVALID_RESPONSE'});}});
it('does not recommend FixedFloat when its minimum is also above the amount',async()=>{const {client}=fixture({price:{...price,errors:['LIMIT_MIN']}});expect(await client.canQuote(params)).toBe(false);});
it('does not recommend FixedFloat for an unsupported asset pair',async()=>{const {client,fetchImpl}=fixture();expect(await client.canQuote({...params,destinationAsset:{...destination,contractAddress:'0x999'}})).toBe(false);expect(fetchImpl).toHaveBeenCalledTimes(1);});
it('requires explicit backup consent before any request',async()=>{const {client,fetchImpl}=fixture();await expect(client.getQuote({...params,backupConsent:false})).rejects.toMatchObject({code:'FIXEDFLOAT_CONSENT_REQUIRED'});expect(fetchImpl).not.toHaveBeenCalled();});
it.each([{...destination,contractAddress:'0x999'},{...destination,blockchain:'eth'},{...origin,blockchain:'bsc'}])('rejects wrong asset identity',asset=>expect(matchFixedFloatAsset(asset,currencies,'send')).toBeNull());
it('rejects duplicate asset matches',()=>expect(matchFixedFloatAsset(origin,[currencies[0],currencies[0]],'recv')).toBeNull());
it.each([['LIMIT_MIN','AMOUNT_TOO_LOW'],['LIMIT_MAX','AMOUNT_TOO_HIGH'],['OFFLINE_TO','NO_LIQUIDITY_ROUTE'],['RESERVE_TO','NO_LIQUIDITY_ROUTE']])('classifies %s',async(error,code)=>{const {client}=fixture({price:{...price,errors:[error]}});await expect(client.getQuote(params)).rejects.toMatchObject({code});});
it.each([{...order,type:'fixed'},{...order,to:{...order.to,address:'attacker'}},{...order,from:{...order.from,network:'BTC'}},{...order,token:''}])('rejects inconsistent orders',async bad=>{const {client}=fixture({create:bad});await expect(client.getQuote({...params,dry:false})).rejects.toThrow();});
it('never retries a timed-out create request',async()=>{const {client,fetchImpl}=fixture({create:new Error('timeout')});await expect(client.getQuote({...params,dry:false})).rejects.toThrow();expect(fetchImpl.mock.calls.filter(([url])=>url.endsWith('/create'))).toHaveLength(1);});
it('persists security token and tracks actual settled output after restart',async()=>{const {client}=fixture();const stored=JSON.parse(JSON.stringify(await client.getQuote({...params,dry:false})));const restarted=fixture();const result=await restarted.client.getExecutionStatus({executable_quote:stored,deposit_address:'deposit',recipient:'recipient',refund_to:'refund'});expect(result).toMatchObject({status:'SUCCESS',swapDetails:{amountOutFormatted:'53.8'}});expect(JSON.stringify(result)).not.toContain('private-order-token');expect(JSON.parse(restarted.fetchImpl.mock.calls[0][1].body)).toEqual({id:'ABC123',token:'private-order-token'});});
it.each(['EMERGENCY','EXPIRED'])('keeps %s tracked without making a financial choice',async status=>{const {client,fetchImpl}=fixture({order:{...order,status}});const stored=await client.getQuote({...params,dry:false});expect(await client.getExecutionStatus({executable_quote:stored,deposit_address:'deposit',recipient:'recipient',refund_to:'refund'})).toMatchObject({status:'PROCESSING',requiresAttention:true});expect(fetchImpl.mock.calls.some(([url])=>url.includes('emergency'))).toBe(false);});
});
describe('exact route choices',()=>{
const data={originAssetId:'ltc',destinationAssetId:'usdt-bsc',amountBase:'100000000',recipient:'recipient',refundTo:'refund'};
const fingerprint=JSON.stringify([data.originAssetId,data.destinationAssetId,data.amountBase,data.recipient,data.refundTo]);
it('rejects stale backup choices when the amount changes',async()=>{const service=Object.create(TicketService.prototype);await expect(service.routeTicketInteraction({isButton:()=>true},{step:'USD_AMOUNT',state_data:{...data,amountBase:'200000000',noRouteOffer:fingerprint}},'use-backup')).rejects.toThrow('Request a new quote');});
it('saves exact route notification choice without calling a swap provider',async()=>{const service=Object.create(TicketService.prototype);service.repositories={enableRouteWatch:vi.fn().mockResolvedValue({id:'ticket'})};const interaction={isButton:()=>true,update:vi.fn()};await service.routeTicketInteraction(interaction,{id:'ticket',step:'USD_AMOUNT',state_data:{...data,noRouteOffer:fingerprint}},'watch-exact');expect(service.repositories.enableRouteWatch).toHaveBeenCalledWith('ticket','exact');expect(interaction.update).toHaveBeenCalled();});
it('explicit backup selection creates only a preview first',async()=>{const service=Object.create(TicketService.prototype);service.repositories={cancelRouteWatch:vi.fn()};service.updateAndRender=vi.fn().mockResolvedValue(true);service.createPreviewFromChat=vi.fn().mockResolvedValue({ok:true});await service.routeTicketInteraction({isButton:()=>true},{id:'ticket',step:'USD_AMOUNT',state_data:{...data,noRouteOffer:fingerprint}},'use-backup');expect(service.createPreviewFromChat).toHaveBeenCalledWith('ticket',expect.objectContaining({backupConsent:true}),null);});
it('notification probe excludes paid backup',async()=>{const service=Object.create(TicketService.prototype);service.catalogue={getAsset:vi.fn(id=>id==='ltc'?origin:destination)};service.oneClick={getVerifiedQuote:vi.fn().mockRejectedValue(new Error('no route'))};service.repositories={completeRouteWatchCheck:vi.fn()};await service.checkWatchedExactRoute({id:'ticket',state_data:{...data,noRouteOffer:fingerprint},route_watch_claimed_at:'lease'});expect(service.oneClick.getVerifiedQuote).toHaveBeenCalledWith(expect.objectContaining({dry:true,amountBase:'100000000'}));expect(service.oneClick.getVerifiedQuote.mock.calls[0][0]).not.toHaveProperty('backupConsent');});
});

describe('FixedFloat recovery', () => {
  it.each(['EXCHANGE', 'REFUND'])('submits an explicit %s choice after validating the order', async choice => {
    const {client, fetchImpl} = fixture({order: {...order, status:'EMERGENCY', emergency:{status:['LESS'],choice:'NONE',repeat:false}}, emergency:{success:true}});
    const stored = await client.getQuote({...params,dry:false});
    await client.chooseRecovery({executable_quote:stored, deposit_address:'deposit', recipient:'recipient',refund_to:'refund'}, choice);
    const calls=fetchImpl.mock.calls.filter(([url])=>url.endsWith('/emergency'));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({id:'ABC123',token:'private-order-token',choice,...(choice==='REFUND'?{address:'refund'}:{})});
  });
  it.each([{status:'DONE'}, {status:'EMERGENCY',emergency:{status:['LESS'],choice:'REFUND'}}, {status:'EMERGENCY',emergency:{status:['LESS','LIMIT'],choice:'NONE'}}, {status:'EMERGENCY',emergency:{status:['LESS'],choice:'NONE',repeat:1}}])('rejects stale or ineligible exchange choices', async state => {
    const {client,fetchImpl}=fixture({order:{...order,...state}});
    const stored=await client.getQuote({...params,dry:false});
    await expect(client.chooseRecovery({executable_quote:stored,deposit_address:'deposit',recipient:'recipient',refund_to:'refund'},'EXCHANGE')).rejects.toThrow();
    expect(fetchImpl.mock.calls.some(([url])=>url.endsWith('/emergency'))).toBe(false);
  });
});

 describe('FixedFloat displayed fee comparison', () => {
  it.each([true, false])('uses current provider USD values for preview and created order (dry=%s)', async dry => {
    const values = {from:{...price.from,usd:55},to:{...price.to,usd:54.725}};
    const {client}=fixture({price:{...price,...values},create:{...order,from:{...order.from,usd:55},to:{...order.to,usd:54.725}}});
    const q=await client.getQuote({...params,dry});
    expect(q.quote.amountOutUsd).toBe('54.00000000');
    expect(quotedRouteCostPercentDisplay(q.quote)).toBe('0.50%');
  });
  it('preserves the 0.50% preview estimate when create omits USD values', async () => {
    const values={from:{...price.from,usd:100},to:{...price.to,usd:99.5}};
    const {client,fetchImpl}=fixture({price:{...price,...values}});
    const parameters={...params,originAsset:{...origin,price:100},destinationAsset:{...destination,price:99.23/54}};
    const preview=await client.getQuote({...parameters,dry:true});
    const active=await client.getQuote({...parameters,dry:false});
    expect(active.quote.amountOutUsd).toBe('99.23000000');
    expect(active.quote.providerUsd).toEqual(preview.quote.providerUsd);
    expect(quotedRouteCostPercentDisplay(preview.quote)).toBe('0.50%');
    expect(quotedRouteCostPercentDisplay(active.quote)).toBe('0.50%');
    expect(fetchImpl.mock.calls.filter(([url])=>url.endsWith('/create'))).toHaveLength(1);
  });
  it('uses the lower catalogue estimate and handles missing provider values', () => {
    const quote={amountInUsd:'100',amountOutUsd:'99.8',providerUsd:{amountInUsd:100,amountOutUsd:99.5}};
    expect(quotedRouteCostPercentDisplay(quote)).toBe('0.20%');
    expect(quotedRouteCostPercentDisplay({...quote,providerUsd:{}})).toBe('0.20%');
    expect(quotedRouteCostPercentDisplay({providerUsd:{amountInUsd:100,amountOutUsd:99.5}})).toBe('0.50%');
  });
});
