package space.davids_digital.giexchange.core.ledger

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.UserId

/**
 * Creates value out of nothing, on purpose: credits come from the GRANTS account, whose negative
 * balance is the total ever issued, and items are minted on behalf of the market's game, with an
 * entry in item_events. Used for guests' starter packs and for topping up bots.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
class Grants(private val jdbc: JdbcClient, private val ledger: Ledger) {

    fun credits(userId: UserId, amount: Long, reference: String) {
        require(amount > 0) { "A credit grant must be positive: $amount" }
        ledger.post(
            LedgerTxKind.GRANT,
            reference,
            ledger.platformAccount(AccountKind.GRANTS) to -amount,
            ledger.userAccount(userId, AccountKind.AVAILABLE) to amount,
        )
    }

    /**
     * Mints fungible items into the user's inventory.
     * Returns false, changing nothing, if there is no such market or its items are not fungible.
     */
    fun items(userId: UserId, marketKey: String, quantity: Long): Boolean {
        require(quantity > 0) { "An item grant must be positive: $quantity" }
        val gameId = jdbc.sql(
            """
            select m.game_id from markets m join item_definitions d using (game_id, def_id)
            where m.market_key = :market and d.kind = 'FUNGIBLE'
            """
        )
            .param("market", marketKey)
            .query(String::class.java)
            .optional()
            .orElse(null)
            ?: return false

        jdbc.sql(
            """
            insert into balances (owner_id, market_key, available) values (:user, :market, :quantity)
            on conflict (owner_id, market_key) do update set available = balances.available + excluded.available
            """
        )
            .param("user", userId.value)
            .param("market", marketKey)
            .param("quantity", quantity)
            .update()

        jdbc.sql(
            """
            insert into item_events (kind, game_id, owner_id, market_key, quantity)
            values ('MINT', :game, :user, :market, :quantity)
            """
        )
            .param("game", gameId)
            .param("user", userId.value)
            .param("market", marketKey)
            .param("quantity", quantity)
            .update()
        return true
    }
}
