/*
 * Copyright 2023, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */
'use strict'

import { expect } from 'chai'
import { ethers, constants } from 'ethers'
import dotenv from 'dotenv'

import { Wallet } from '@ethersproject/wallet'
import { parseEther } from '@ethersproject/units'

import { skipIfMainnet, wait } from '../testHelpers'

import { testSetup as _testSetup } from '../../../scripts/testSetup'
import { ERC20__factory } from '../../../src/lib/abi/factories/ERC20__factory'

dotenv.config()

// create one random wallet for the test
const wallet = Wallet.createRandom()

async function testSetup() {
  const result = await _testSetup()
  const { l2Network, l1Provider, l2Provider } = result

  const nativeToken = l2Network.nativeToken!
  const nativeTokenContract = ERC20__factory.connect(nativeToken, l1Provider)

  const l1Signer = wallet.connect(l1Provider)
  const l2Signer = wallet.connect(l2Provider)

  return { ...result, nativeTokenContract, l1Signer, l2Signer }
}

async function fundL1(account: string) {
  const { l1Provider, nativeTokenContract } = await testSetup()

  const l1DeployerWallet = new ethers.Wallet(
    ethers.utils.sha256(ethers.utils.toUtf8Bytes('user_l1user')),
    l1Provider
  )

  // send 1 eth to account
  const fundEthTx = await l1DeployerWallet.sendTransaction({
    to: account,
    value: parseEther('1'),
  })
  await fundEthTx.wait()

  // send 10 erc-20 tokens to account
  const fundTokenTx = await nativeTokenContract
    .connect(l1DeployerWallet)
    .transfer(account, parseEther('10'))
  await fundTokenTx.wait()
}

describe('EthBridger (with erc-20 as native token)', async () => {
  before(async function () {
    const { l1Signer } = await testSetup()
    await fundL1(await l1Signer.getAddress())
  })

  beforeEach('skipIfMainnet', async function () {
    await skipIfMainnet(this)
  })

  it('approves the erc-20 token on the parent chain for an arbitrary amount', async function () {
    const { ethBridger, nativeTokenContract, l1Provider } = await testSetup()

    // using a random wallet for non-max amount approval
    // the rest of the test suite will use the account with the max approval
    const randomL1Signer = Wallet.createRandom().connect(l1Provider)
    await fundL1(await randomL1Signer.getAddress())

    const inbox = ethBridger.l2Network.ethBridge.inbox
    const amount = ethers.utils.parseEther('1')

    const approvalTx = await ethBridger.approve({
      amount,
      l1Signer: randomL1Signer,
    })
    await approvalTx.wait()

    const allowance = await nativeTokenContract.allowance(
      await randomL1Signer.getAddress(),
      inbox
    )

    expect(allowance.toString()).to.equal(
      amount.toString(),
      'allowance incorrect'
    )
  })

  it('approves the erc-20 token on the parent chain for the max amount', async function () {
    const { ethBridger, nativeTokenContract, l1Signer } = await testSetup()
    const inbox = ethBridger.l2Network.ethBridge.inbox

    const approvalTx = await ethBridger.approve({ l1Signer })
    await approvalTx.wait()

    const allowance = await nativeTokenContract.allowance(
      await l1Signer.getAddress(),
      inbox
    )

    expect(allowance.toString()).to.equal(
      constants.MaxUint256.toString(),
      'allowance incorrect'
    )
  })

  it('deposits erc-20 token via params', async function () {
    const result = await testSetup()
    const { ethBridger, nativeTokenContract, l1Signer, l2Signer } = result
    const bridge = ethBridger.l2Network.ethBridge.bridge

    const amount = parseEther('2')

    const initialBalanceBridge = await nativeTokenContract.balanceOf(bridge)
    const initialBalanceDepositor = await l2Signer.getBalance()

    // perform the deposit
    const depositTx = await ethBridger.deposit({
      amount,
      l1Signer,
    })
    await depositTx.wait()

    expect(
      // balance in the bridge after the deposit
      (await nativeTokenContract.balanceOf(bridge)).toString()
    ).to.equal(
      // balance in the bridge after the deposit should equal to the initial balance in the bridge + the amount deposited
      initialBalanceBridge.add(amount).toString(),
      'incorrect balance in bridge after deposit'
    )

    // wait for minting on L2
    await wait(30 * 1000)

    expect(
      // balance in the depositor account after the deposit
      (await l2Signer.getBalance()).toString()
    ).to.equal(
      // balance in the depositor account after the deposit should equal to the initial balance in th depositor account + the amount deposited
      initialBalanceDepositor.add(amount).toString(),
      'incorrect balance in depositor account after deposit'
    )
  })
})
