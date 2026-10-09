package space.davids_digital.giexchange.core.ledger

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.UserId

enum class AccountKind { AVAILABLE, RESERVED, FEES, GRANTS }

enum class LedgerTxKind { GRANT, RESERVE, RELEASE, TRADE }

class InsufficientFundsException(val accountId: Long, val balance: Long, val required: Long) :
    RuntimeException("Account $accountId has $balance, $required required")

/**
 * The only way to move credits. Never opens a transaction of its own: postings are always
 * part of the business change that caused them, so both are committed or neither is.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
class Ledger(private val jdbc: JdbcClient) {

    fun userAccount(userId: UserId, kind: AccountKind): Long =
        jdbc.sql("select account_id from accounts where owner_id = :owner and kind = :kind")
            .param("owner", userId.value)
            .param("kind", kind.name)
            .query(Long::class.javaObjectType)
            .single()

    fun platformAccount(kind: AccountKind): Long =
        jdbc.sql("select account_id from accounts where owner_id is null and kind = :kind")
            .param("kind", kind.name)
            .query(Long::class.javaObjectType)
            .single()

    /**
     * Writes one ledger transaction. Each entry is an account id and a signed amount; amounts for the
     * same account are merged, so a user trading with themselves does not break anything.
     * The amounts must sum to zero.
     *
     * Locks the accounts in account_id order: concurrent transactions over the same accounts
     * wait for each other instead of deadlocking.
     */
    fun post(txKind: LedgerTxKind, reference: String, vararg entries: Pair<Long, Long>): Long {
        val postings = entries
            .groupingBy { it.first }
            .fold(0L) { sum, entry -> Math.addExact(sum, entry.second) }
            .filterValues { it != 0L }
        require(postings.isNotEmpty()) { "A ledger transaction needs at least one non-zero posting" }
        require(postings.values.fold(0L) { a, b -> Math.addExact(a, b) } == 0L) {
            "Postings must sum to zero: $postings"
        }

        val accounts = jdbc.sql(
            """
            select account_id, kind, balance from accounts
            where account_id in (:ids)
            order by account_id
            for update
            """
        )
            .param("ids", postings.keys)
            .query { rs, _ ->
                LockedAccount(rs.getLong("account_id"), AccountKind.valueOf(rs.getString("kind")), rs.getLong("balance"))
            }
            .list()
        check(accounts.size == postings.size) { "Unknown account among ${postings.keys}" }

        for ((id, kind, balance) in accounts) {
            val amount = postings.getValue(id)
            // Source accounts go negative by design: their balance is the amount they issued
            if (kind != AccountKind.GRANTS && Math.addExact(balance, amount) < 0) {
                throw InsufficientFundsException(id, balance, -amount)
            }
        }

        val txId = jdbc.sql(
            "insert into ledger_transactions (kind, reference) values (:kind, :reference) returning ledger_tx_id"
        )
            .param("kind", txKind.name)
            .param("reference", reference)
            .query(Long::class.javaObjectType)
            .single()

        for ((id) in accounts) {
            val amount = postings.getValue(id)
            jdbc.sql("insert into postings (ledger_tx_id, account_id, amount) values (:tx, :account, :amount)")
                .param("tx", txId)
                .param("account", id)
                .param("amount", amount)
                .update()
            jdbc.sql("update accounts set balance = balance + :amount where account_id = :account")
                .param("amount", amount)
                .param("account", id)
                .update()
        }
        return txId
    }

    private data class LockedAccount(val id: Long, val kind: AccountKind, val balance: Long)
}
