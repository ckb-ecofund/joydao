import { CKBTransaction } from "@joyid/ckb";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { predefined } from "@ckb-lumos/config-manager";
import { dao, common } from "@ckb-lumos/common-scripts";
import { Address, Cell, Transaction } from "@ckb-lumos/base";
import { unlock } from "./lumos-patcher"; // TODO to be replaced
import { generateDefaultScriptInfos } from "@ckb-ccc/lumos-patches";
import {
  INDEXER_URL,
  DAO_MINIMUM_CAPACITY,
  FEE_RATE,
  ISMAINNET,
} from "../config";
import { registerCustomLockScriptInfos, LockScriptInfo } from "@ckb-lumos/common-scripts/lib/common";

import {
  TransactionSkeleton,
  createTransactionFromSkeleton,
} from "@ckb-lumos/helpers";
import {
  ckbytesToShannons,
  insertJoyIdWithnessPlaceHolder,
  getFee,
  hexToInt,
  isJoyIdAddress,
} from "./lib/helpers";

const indexer = new Indexer(INDEXER_URL);
registerCustomLockScriptInfos(generateDefaultScriptInfos());

/**
 * Fetch DAO deposits.
 *
 * @param ckbAddress - The ckb address from which deposit cells are queried.
 * @returns An array of deposit cells.
 */
export const collectDeposits = async (ckbAddress: Address): Promise<Cell[]> => {
  let depositCells: Cell[] = [];
  const daoCellCollector = new dao.CellCollector(
    ckbAddress,
    indexer,
    "deposit"
  );
  for await (const inputCell of daoCellCollector.collect()) {
    depositCells.push(inputCell);
  }
  return depositCells;
};

/**
 * Fetch DAO withdrawals.
 *
 * @param ckbAddress - The ckb address from which withdrawal cells are queried.
 * @returns An array of withdrawal cells.
 */
export const collectWithdrawals = async (
  ckbAddress: Address
): Promise<Cell[]> => {
  let depositCells: Cell[] = [];
  const daoCellCollector = new dao.CellCollector(
    ckbAddress,
    indexer,
    "withdraw"
  );
  for await (const inputCell of daoCellCollector.collect()) {
    depositCells.push(inputCell);
  }
  return depositCells;
};

/**
 * Buid DAO deposit transaction.
 *
 * @param ckbAddress - The ckb address that will holds the deposit
 * @param amount - The amount to deposit.
 * @returns A CKB raw transaction.
 */
export const buildDepositTransaction = async (
  ckbAddress: Address,
  amount: bigint
): Promise<{ tx: CKBTransaction; fee: number }> => {
  amount = ckbytesToShannons(amount);
  if (amount < ckbytesToShannons(BigInt(DAO_MINIMUM_CAPACITY)))
    throw new Error("Minimum DAO deposit is 104 CKB.");

  const configuration = ISMAINNET ? predefined.LINA : predefined.AGGRON4;
  let txSkeleton = new TransactionSkeleton({ cellProvider: indexer });

  txSkeleton = await dao.deposit(txSkeleton, ckbAddress, ckbAddress, amount, {
    config: configuration,
    enableNonSystemScript: true,
  });

  // patching joyID tx fee and lumos::common-script::dao::unlock
  if (isJoyIdAddress(ckbAddress))
    txSkeleton = insertJoyIdWithnessPlaceHolder(txSkeleton);

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    [ckbAddress],
    BigInt(FEE_RATE),
    undefined,
    {
      config: configuration,
    }
  );

  const txFee = getFee(txSkeleton);
  const daoDepositTx: Transaction = createTransactionFromSkeleton(txSkeleton);
  return { tx: daoDepositTx as CKBTransaction, fee: txFee };
};

/**
 * Buid DAO withdraw raw transaction.
 *
 * @param ckbAddress - The ckb address that owns the cell to be withdrawn.
 * @param daoDepositCell - The deposit cell.
 * @returns A CKB raw transaction.
 */
export const buildWithdrawTransaction = async (
  ckbAddress: Address,
  daoDepositCell: Cell
): Promise<{ tx: CKBTransaction; fee: number }> => {
  const configuration = ISMAINNET ? predefined.LINA : predefined.AGGRON4;
  let txSkeleton = new TransactionSkeleton({ cellProvider: indexer });

  txSkeleton = await dao.withdraw(txSkeleton, daoDepositCell, ckbAddress, {
    config: configuration,
    enableNonSystemScript: true,
  });

  // patching joyID tx fee and lumos::common-script::dao::unlock
  if (isJoyIdAddress(ckbAddress))
    txSkeleton = insertJoyIdWithnessPlaceHolder(txSkeleton);

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    [ckbAddress],
    BigInt(FEE_RATE),
    undefined,
    {
      config: configuration,
    }
  );

  const txFee = getFee(txSkeleton);
  const daoWithdrawTx: Transaction = createTransactionFromSkeleton(txSkeleton);
  return { tx: daoWithdrawTx as CKBTransaction, fee: txFee };
};

/**
 * Buid DAO unlock raw transaction.
 *
 * @param ckbAddress - The ckb address that owns the cell to be unlocked.
 * @param daoWithdrawalCell - The withdrawal cell.
 * @returns A CKB raw transaction.
 */
export const buildUnlockTransaction = async (
  ckbAddress: Address,
  daoWithdrawalCell: Cell
): Promise<{ tx: CKBTransaction; fee: number }> => {
  const configuration = ISMAINNET ? predefined.LINA : predefined.AGGRON4;
  let txSkeleton = TransactionSkeleton({ cellProvider: indexer });

  txSkeleton = await unlock(txSkeleton, ckbAddress, daoWithdrawalCell);

  // patching joyID tx fee and lumos::common-script::dao::unlock
  if (isJoyIdAddress(ckbAddress))
    txSkeleton = insertJoyIdWithnessPlaceHolder(txSkeleton);

  const inputCapacity = txSkeleton.inputs
    .toArray()
    .reduce((a, c) => a + hexToInt(c.cellOutput.capacity), BigInt(0));
  const outputCapacity = txSkeleton.outputs
    .toArray()
    .reduce((a, c) => a + hexToInt(c.cellOutput.capacity), BigInt(0));
  const reward = outputCapacity - inputCapacity;

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    [ckbAddress],
    BigInt(FEE_RATE),
    undefined,
    {
      config: configuration,
    }
  );

  const txFee = getFee(txSkeleton, reward);
  const daoUnlockTx: Transaction = createTransactionFromSkeleton(txSkeleton);
  return { tx: daoUnlockTx as CKBTransaction, fee: txFee };
};

/**
 * Batch deposits or/with cells to withdraw or/and unlock at once.
 *
 * @param ckbAddress - The ckb address that owns the cells to be batched.
 * @param cells - An array of deposit cells or/with at-end-cycle withdrawal cells.
 * @returns A CKB raw transaction.
 */
export const batchDaoCells = async (
  ckbAddress: Address,
  cells: Cell[]
): Promise<{ tx: CKBTransaction; fee: number }> => {
  let txSkeleton = TransactionSkeleton({ cellProvider: indexer });
  const depositCells: Cell[] = cells.filter(
    (cell) => cell.data == "0x0000000000000000"
  );
  const withdrawCells: Cell[] = cells.filter(
    (cell) => cell.data != "0x0000000000000000"
  );
  const configuration = ISMAINNET ? predefined.LINA : predefined.AGGRON4;

  // Batching deposit cells
  for (const cell of depositCells) {
    txSkeleton = await dao.withdraw(txSkeleton, cell as Cell, ckbAddress, {
      config: configuration,
      enableNonSystemScript: true,
    });
  }

  // patching joyID tx fee and lumos::common-script::dao::unlock
  if (isJoyIdAddress(ckbAddress))
    txSkeleton = insertJoyIdWithnessPlaceHolder(txSkeleton);

  // Batching withdrawal cells
  for (const cell of withdrawCells) {
    //TODO replace when lumos supports joyID for dao unlocking
    txSkeleton = await unlock(txSkeleton, ckbAddress, cell as Cell);
  }

  // patching joyID tx fee and lumos::common-script::dao::unlock
  if (isJoyIdAddress(ckbAddress))
    txSkeleton = insertJoyIdWithnessPlaceHolder(txSkeleton);

  txSkeleton = await common.payFeeByFeeRate(
    txSkeleton,
    [ckbAddress],
    BigInt(FEE_RATE),
    undefined,
    {
      config: configuration,
    }
  );

  const txFee = getFee(txSkeleton);
  const daoWithdrawTx: Transaction = createTransactionFromSkeleton(txSkeleton);
  return { tx: daoWithdrawTx as CKBTransaction, fee: txFee };
};
