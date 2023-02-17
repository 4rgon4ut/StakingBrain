import {
  Web3signerDeleteRequest,
  Web3signerDeleteResponse,
  Web3signerPostRequest,
  CustomValidatorsImportRequest,
  Web3signerPostResponse,
  CustomValidatorGetResponse,
  Tag,
  shortenPubkey,
} from "@stakingbrain/common";
import {
  beaconchainApi,
  brainDb,
  signerApi,
  signerUrl,
  validatorApi,
} from "../index.js";
import logger from "../modules/logger/index.js";
import { cron } from "../index.js";

/**
 * Import keystores:
 * 1. Import keystores + passwords on web3signer API
 * 2. Import pubkeys on validator API
 * 3. Import feeRecipient on Validator API
 * 4. Write on db must go last because if signerApi fails does not make sense to write on db since cron will not delete them at some point
 * @param postRequest
 * @returns Web3signerPostResponse
 */
export async function importValidators(
  postRequest: CustomValidatorsImportRequest
): Promise<Web3signerPostResponse> {
  try {
    // IMPORTANT: stop the cron. This removes the scheduled cron task from the task queue
    // and prevents the cron from running while we are importing validators
    cron.stop();

    // 0. Check if already exists?
    function readFile(files: File[]): string[] {
      const fileContents: string[] = [];
      // Type File is from the web, cast it to Buffer
      for (const file of files as unknown as Buffer[])
        fileContents.push(file.toString());
      return fileContents;
    }

    const keystores =
      postRequest.importFrom === "ui"
        ? readFile(postRequest.keystores as File[])
        : (postRequest.keystores as string[]);

    let importSignerData: Web3signerPostRequest;
    if (postRequest.slashing_protection) {
      importSignerData = {
        keystores,
        passwords: postRequest.passwords,
        slashing_protection:
          postRequest.importFrom === "ui"
            ? readFile([
                [postRequest.slashing_protection] as unknown as File,
              ])[0]
            : (postRequest.slashing_protection as string),
      };
    } else {
      importSignerData = {
        keystores,
        passwords: postRequest.passwords,
      };
    }

    const pubkeys: string[] = keystores.map(
      (keystore) => JSON.parse(keystore).pubkey
    );

    const signerImportedData: {
      pubkey: string;
      tag: Tag;
      feeRecipient: string;
    }[] = [];

    // 1. Import keystores and passwords on web3signer API
    const web3signerPostResponse: Web3signerPostResponse =
      await signerApi.importKeystores(importSignerData);
    // Signer API import keystore may fail for some keystores, but not all
    // @see https://github.com/ConsenSys/web3signer/issues/713
    // Remove the pubkeys to avoid adding them to the db
    for (const [index, pubkey] of pubkeys.entries())
      if (web3signerPostResponse.data[index].status === "error") {
        logger.error(
          `Error importing keystore for pubkey ${shortenPubkey(pubkey)}: ${
            web3signerPostResponse.data[index].message
          }`
        );
      } else {
        signerImportedData.push({
          pubkey,
          tag: postRequest.tags[index],
          feeRecipient: postRequest.feeRecipients[index],
        });
      }

    logger.debug(
      `Imported keystores into web3signer API: ${JSON.stringify(
        web3signerPostResponse.data
      )}`
    );

    const signerImportedPubkeys = signerImportedData.map((data) => data.pubkey);
    
    postRequest.feeRecipients = signerImportedData.map(
      (data) => data.feeRecipient
    );
    postRequest.tags = signerImportedData.map((data) => data.tag);

    // 2. Import pubkeys on validator API
    await validatorApi
      .postRemoteKeys({
        remote_keys: signerImportedPubkeys.map((pubkey) => ({
          pubkey,
          url: signerUrl,
        })),
      })
      .then(() => logger.debug(`Added pubkeys to validator API`))
      .catch((err) => {
        logger.error(`Error setting validator pubkeys`, err);
      });

    // 3. Import feeRecipient on Validator API
    for (const [index, pubkey] of signerImportedPubkeys.entries())
      await validatorApi
        .setFeeRecipient(postRequest.feeRecipients[index], pubkey)
        .then(() => logger.debug(`Added feeRecipient to validator API`))
        .catch((err) =>
          logger.error(`Error setting validator feeRecipient`, err)
        );

    // 4. Write on db
    brainDb.addValidators({
      pubkeys: signerImportedPubkeys,
      tags: postRequest.tags,
      feeRecipients: postRequest.feeRecipients,
      automaticImports:
        postRequest.importFrom === "ui"
          ? Array(signerImportedPubkeys.length).fill(false)
          : Array(signerImportedPubkeys.length).fill(true),
    });
    logger.debug(`Added pubkeys to db: ${signerImportedPubkeys.join(", ")}`);

    // IMPORTANT: start the cron
    cron.start();
    return web3signerPostResponse;
  } catch (e) {
    cron.restart();
    throw e;
  }
}

/**
 * Updates validators on DB:
 * 1. Write on db MUST goes first because if signerApi fails, cron will try to delete them
 * 2. Import feeRecipient on Validator API
 * @param param0
 */
export async function updateValidators({
  pubkeys,
  feeRecipients,
  tags,
}: {
  pubkeys: string[];
  feeRecipients: string[];
  tags: Tag[];
}): Promise<void> {
  try {
    // IMPORTANT: stop the cron. This removes the scheduled cron task from the task queue
    // and prevents the cron from running while we are importing validators
    cron.stop();

    brainDb.updateValidators({
      pubkeys,
      tags,
      feeRecipients,
      automaticImports: Array(pubkeys.length).fill(false),
    });

    // Import feeRecipient on Validator API
    for (const [index, pubkey] of pubkeys.entries())
      await validatorApi
        .setFeeRecipient(feeRecipients[index], pubkey)
        .then(() => logger.debug(`Added feeRecipient to validator API`))
        .catch((err) =>
          // TODO: write empty fee recipient on db
          logger.error(`Error setting validator feeRecipient`, err)
        );

    // IMPORTANT: start the cron
    cron.start();
  } catch (e) {
    cron.restart();
    throw e;
  }
}

/**
 * Delete keystores:
 * 1. Write on db
 * 2. Delete keystores on web3signer API
 * 3. Delete pubkeys on validator API
 * 4. Delete feeRecipient on Validator API
 * @param deleteRequest
 * @returns
 */
export async function deleteValidators(
  deleteRequest: Web3signerDeleteRequest
): Promise<Web3signerDeleteResponse> {
  try {
    // IMPORTANT: stop the cron. This removes the scheduled cron task from the task queue
    // and prevents the cron from running while we are deleting validators
    cron.stop();

    // Write on db
    brainDb.deleteValidators(deleteRequest.pubkeys);
    // Delete keystores on web3signer API
    const web3signerDeleteResponse = await signerApi.deleteKeystores(
      deleteRequest
    );
    // Delete feeRecipient on Validator API
    for (const pubkey of deleteRequest.pubkeys)
      await validatorApi
        .deleteFeeRecipient(pubkey)
        .then(() => logger.debug(`Deleted fee recipient in validator API`))
        .catch((err) =>
          logger.error(`Error deleting validator feeRecipient`, err)
        );
    // Delete pubkeys on validator API
    await validatorApi
      .deleteRemoteKeys(deleteRequest)
      .then(() => logger.debug(`Deleted pubkeys in validator API`))
      .catch((err) => logger.error(`Error deleting validator pubkeys`, err));

    // IMPORTANT: start the cron
    cron.start();
    return web3signerDeleteResponse;
  } catch (e) {
    cron.restart();
    throw e;
  }
}

/**
 * Get all validators from db
 * If running in development mode (NODE_ENV === "development") it will returns booleans for
 * validatorImported and validatorFeeRecipientCorrect checks from the validator API
 * @returns
 */
export async function getValidators(): Promise<CustomValidatorGetResponse[]> {
  const data = brainDb.data;
  if (!data) return [];

  const validatorPubkeys = (
    await validatorApi.getRemoteKeys().catch((e) => {
      logger.error(e);
      return { data: [] };
    })
  ).data.map((validator) => validator.pubkey);

  const validatorsFeeRecipients = await Promise.all(
    validatorPubkeys.map((pubkey) => validatorApi.getFeeRecipient(pubkey))
  ).catch((e) => {
    logger.error(e);
    return [];
  });

  const validators: CustomValidatorGetResponse[] = [];
  for (const [pubkey, { tag, feeRecipient }] of Object.entries(data))
    validators.push({
      pubkey,
      tag,
      feeRecipient,
      validatorImported: validatorPubkeys.includes(pubkey),
      validatorFeeRecipientCorrect: validatorsFeeRecipients.some(
        (feeRecipient) => feeRecipient === feeRecipient
      ),
    });

  return validators;
}

/**
 * Performs a voluntary exit for a given set of validators as identified via `pubkeys`
 * @param pubkeys The public keys of the validators to exit
 */
export async function exitValidators({ pubkeys }: { pubkeys: string[] }) {
  try {
    // IMPORTANT: stop the cron. This removes the scheduled cron task from the task queue
    // and prevents the cron from running while we are deleting validators
    cron.stop();

    // Get the current epoch from the beaconchain API to exit the validators
    const currentEpoch = await beaconchainApi.getCurrentEpoch();

    // Get the fork from the beaconchain API to sign the voluntary exit
    const fork = await beaconchainApi.getForkFromState({ state_id: "head" });

    // Get the validators indexes from the validator API
    const validatorIndexes = (
      await Promise.all(
        pubkeys.map((pubkey) =>
          beaconchainApi.getValidatorFromState({ state: "head", pubkey })
        )
      )
    ).map((validator) => validator.data.index);

    await Promise.all(
      validatorIndexes.map((validatorIndex) =>
        // Get the voluntary exit signatures from the web3signer API
        signerApi
          .signVoluntaryExit({
            signerVoluntaryExitRequest: {
              type: "VOLUNTARY_EXIT",
              fork_info: {
                fork: {
                  previous_version: fork.data.previous_version,
                  current_version: fork.data.current_version,
                  epoch: fork.data.epoch,
                },
                genesis_validators_root: "", // TODO: get genesis_validators_root from beaconchain API
              },
              voluntary_exit: {
                epoch: currentEpoch.toString(),
                validator_index: validatorIndex,
              },
            },
          })
          .then((signatureResponse) =>
            // Post the voluntary exit to the beaconchain API
            beaconchainApi.postVoluntaryExits({
              postVoluntaryExitsRequest: {
                message: {
                  epoch: currentEpoch.toString(),
                  validator_index: validatorIndex,
                },
                signature: signatureResponse.signature,
              },
            })
          )
      )
    );

    // Delete the validator from the validator API
    await validatorApi
      .deleteRemoteKeys({ pubkeys })
      .then(() => logger.debug(`Deleted pubkeys in validator API`))
      .catch((err) => logger.error(`Error deleting validator pubkeys`, err));

    // Delete the validator from the web3signer API
    await signerApi
      .deleteKeystores({ pubkeys })
      .then(() => logger.debug(`Deleted pubkeys in web3signer API`));

    // Delete the validator from the brain db
    brainDb.deleteValidators(pubkeys);

    // IMPORTANT: start the cron
    cron.start();
  } catch (e) {
    cron.restart();
    throw e;
  }
}
