'use strict'
import { EventManager } from '../eventManager'
import type { Transaction as InternalTransaction } from './txRunner'
import Web3 from 'web3'
import {toBigInt} from 'web3-utils'

export class TxRunnerWeb3 {
  event
  _api
  getWeb3: () => Web3
  currentblockGasLimit: () => number

  constructor (api, getWeb3, currentblockGasLimit) {
    this.event = new EventManager()
    this.getWeb3 = getWeb3
    this.currentblockGasLimit = currentblockGasLimit
    this._api = api
  }

  async _executeTx (tx, network, txFee, api, promptCb, callback) {
    if (network && network.lastBlock && network.lastBlock.baseFeePerGas) {
      // the sending stack (web3.js / metamask need to have the type defined)
      // this is to avoid the following issue: https://github.com/MetaMask/metamask-extension/issues/11824
      tx.type = '0x2'
    } else {
      tx.type = '0x1'
    }
    if (txFee) {
      if (txFee.baseFeePerGas) {
        tx.maxPriorityFeePerGas = this.getWeb3().utils.toHex(this.getWeb3().utils.toWei(txFee.maxPriorityFee, 'gwei'))
        tx.maxFeePerGas = this.getWeb3().utils.toHex(this.getWeb3().utils.toWei(txFee.maxFee, 'gwei'))
        tx.type = '0x2'
      } else {
        tx.gasPrice = this.getWeb3().utils.toHex(this.getWeb3().utils.toWei(txFee.gasPrice, 'gwei'))
        tx.type = '0x1'
      }
    }

    let currentDateTime = new Date();
    const start = currentDateTime.getTime() / 1000
    const cb = (err, resp) => {
      if (err) {
        return callback(err, resp)
      }
      this.event.trigger('transactionBroadcasted', [resp])
      const listenOnResponse = () => {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
          const receipt = await tryTillReceiptAvailable(resp, this.getWeb3())
          tx = await tryTillTxAvailable(resp, this.getWeb3())
          currentDateTime = new Date();
          const end = currentDateTime.getTime() / 1000
          console.log('tx duration', end - start)
          resolve({
            receipt,
            tx,
            transactionHash: receipt ? receipt['transactionHash'] : null
          })
        })
      }
      listenOnResponse().then((txData) => { callback(null, txData) }).catch((error) => { callback(error) })
    }

    if (api.personalMode()) {
      promptCb(
        async (value) => {
          try {
            const res = await (this.getWeb3() as any).eth.personal.sendTransaction({...tx, value})
            cb(null, res.transactionHash)
          } catch (e)  {
            console.log(`Send transaction failed: ${e.message} . if you use an injected provider, please check it is properly unlocked. `)
            // in case the receipt is available, we consider that only the execution failed but the transaction went through.
            // So we don't consider this to be an error.
            if (e.receipt) cb(null, e.receipt.transactionHash)
            else cb(e, null)
          }
        },
        () => {
          return callback('Canceled by user.')
        }
      )
    } else {
      try {
        const res = await this.getWeb3().eth.sendTransaction(tx)
        cb(null, res.transactionHash)
      } catch (e)  {
        console.log(`Send transaction failed: ${e.message} . if you use an injected provider, please check it is properly unlocked. `)
        // in case the receipt is available, we consider that only the execution failed but the transaction went through.
        // So we don't consider this to be an error.
        if (e.receipt) cb(null, e.receipt.transactionHash)
        else cb(e, null)
      }
    }
  }

  execute (args: InternalTransaction, confirmationCb, gasEstimationForceSend, promptCb, callback) {
    let data = args.data
    if (data.slice(0, 2) !== '0x') {
      data = '0x' + data
    }

    return this.runInNode(args.from, args.to, data, args.value, args.gasLimit, args.useCall, args.timestamp, confirmationCb, gasEstimationForceSend, promptCb, callback)
  }

  runInNode (from, to, data, value, gasLimit, useCall, timestamp, confirmCb, gasEstimationForceSend, promptCb, callback) {
    const tx = { from: from, to: to, data: data, value: value }
    if (!from) return callback('the value of "from" is not defined. Please make sure an account is selected.')
    if (useCall) {
      tx['gas'] = gasLimit
      if (this._api && this._api.isVM()) {
        (this.getWeb3() as any).remix.registerCallId(timestamp)
      }
      this.getWeb3().eth.call(tx)
        .then((result: any) => callback(null, {
          result: result
        }))
        .catch(error => callback(error))
      return
    }
    this._api.detectNetwork((errNetWork, network) => {
      if (errNetWork) {
        console.log(errNetWork)
        return
      }
      const txCopy =  { ...tx, type: undefined, maxFeePerGas: undefined, gasPrice: undefined }
      if (network && network.lastBlock) {
        if (network.lastBlock.baseFeePerGas) {
          // the sending stack (web3.js / metamask need to have the type defined)
          // this is to avoid the following issue: https://github.com/MetaMask/metamask-extension/issues/11824
          txCopy.type = '0x2'
          txCopy.maxFeePerGas = Math.ceil(Number((toBigInt(network.lastBlock.baseFeePerGas) + toBigInt(network.lastBlock.baseFeePerGas) / BigInt(3)).toString()))
        } else {
          txCopy.type = '0x1'
          txCopy.gasPrice = undefined
        }
      }
      this.getWeb3().eth.estimateGas(txCopy)
        .then(gasEstimation => {
          gasEstimationForceSend(null, () => {
            // callback is called whenever no error
            tx['gas'] = !gasEstimation ? gasLimit : gasEstimation

            if (this._api.config.getUnpersistedProperty('doNotShowTransactionConfirmationAgain')) {
              return this._executeTx(tx, network, null, this._api, promptCb, callback)
            }

            confirmCb(network, tx, tx['gas'], (txFee) => {
              return this._executeTx(tx, network, txFee, this._api, promptCb, callback)
            }, (error) => {
              callback(error)
            })
          }, callback)
        })
        .catch(err => {
          if (err && err.message.indexOf('Invalid JSON RPC response') !== -1) {
            // // @todo(#378) this should be removed when https://github.com/WalletConnect/walletconnect-monorepo/issues/334 is fixed
            callback(new Error('Gas estimation failed because of an unknown internal error. This may indicated that the transaction will fail.'))
          }
          err = network.name === 'VM' ? null : err // just send the tx if "VM"
          gasEstimationForceSend(err, () => {
            tx['gas'] = gasLimit

            if (this._api.config.getUnpersistedProperty('doNotShowTransactionConfirmationAgain')) {
              return this._executeTx(tx, network, null, this._api, promptCb, callback)
            }

            confirmCb(network, tx, tx['gas'], (txFee) => {
              return this._executeTx(tx, network, txFee, this._api, promptCb, callback)
            }, (error) => {
              callback(error)
            })
          }, callback)
        })
    })
  }
}

async function tryTillReceiptAvailable (txhash, web3) {
  try {
    const receipt = await web3.eth.getTransactionReceipt(txhash)
    if (receipt) return receipt
  } catch (e) {}
  await pause()
  return await tryTillReceiptAvailable(txhash, web3)
}

async function tryTillTxAvailable (txhash, web3) {
  try {
    const tx = await web3.eth.getTransaction(txhash)
    if (tx && tx.blockHash) return tx
  } catch (e) {}
  return await tryTillTxAvailable(txhash, web3)
}

async function pause () { return new Promise((resolve, reject) => { setTimeout(resolve, 500) }) }
