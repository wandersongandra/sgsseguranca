/**
 * Referência obrigatória para qualquer operação de storage tenant-scoped.
 *
 * A chave continua sendo persistida como string nas entidades existentes, mas
 * a boundary do provider recebe sempre esta referência governada. Assim, o
 * tenant, o recurso proprietário e a finalidade não ficam implícitos em uma
 * chamada `download(key)`/`delete(key)`.
 */
export interface StorageObjectOwner {
  resourceType: string;
  resourceId: string;
}

export interface StorageObjectReference {
  tenantId: string;
  key: string;
  owner: StorageObjectOwner;
  purpose: string;
  /**
   * Compatibilidade somente para objetos históricos sem tenant no prefixo.
   * Este sinal nunca permite criar uma nova chave legada; ele apenas autoriza
   * a leitura/remoção de uma chave já persistida e validada pelo domínio.
   */
  legacy?: boolean;
}

/**
 * Marca privada de uma referência cuja relação tenant/owner/resource/purpose
 * foi resolvida contra uma fonte persistida. A propriedade é não-enumerável
 * para que a capability não seja transportada por JSON ou request input.
 */
const AUTHORIZED_STORAGE_REFERENCE = Symbol('authorized-storage-reference');

export type AuthorizedStorageObjectReference = StorageObjectReference & {
  readonly [AUTHORIZED_STORAGE_REFERENCE]: true;
};

export function markAuthorizedStorageReference(
  reference: StorageObjectReference,
): AuthorizedStorageObjectReference {
  Object.defineProperty(reference, AUTHORIZED_STORAGE_REFERENCE, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return reference as AuthorizedStorageObjectReference;
}

export function isAuthorizedStorageObjectReference(
  reference: unknown,
): reference is AuthorizedStorageObjectReference {
  return Boolean(
    reference &&
    typeof reference === 'object' &&
    (reference as Partial<AuthorizedStorageObjectReference>)[
      AUTHORIZED_STORAGE_REFERENCE
    ] === true,
  );
}

export interface StoragePrefixReference {
  tenantId: string;
  prefix: string;
  owner: StorageObjectOwner;
  purpose: string;
  legacy?: boolean;
}

export type StorageOperation =
  | 'upload'
  | 'download'
  | 'delete'
  | 'presign'
  | 'upload-presign'
  | 'list'
  | 'copy'
  | 'move'
  | 'replace';
