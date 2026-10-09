package space.davids_digital.giexchange.core.me

import com.fasterxml.jackson.annotation.JsonRawValue
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import space.davids_digital.giexchange.core.auth.AuthenticatedUser

data class WalletResponse(val available: Long, val reserved: Long)

data class FungibleItemView(
    val marketId: Long,
    val gameId: String,
    val defId: String,
    val name: String,
    val available: Long,
    val reserved: Long,
)

data class UniqueItemView(
    val assetId: Long,
    val marketId: Long,
    val gameId: String,
    val defId: String,
    val name: String,
    val state: String,
    /** Stored as jsonb and sent as is: the platform does not interpret game attributes. */
    @get:JsonRawValue val attributes: String,
)

data class InventoryResponse(val fungible: List<FungibleItemView>, val unique: List<UniqueItemView>)

@RestController
@RequestMapping("/api/v1/me")
class MeController(private val jdbc: JdbcClient) {

    /** Both numbers come from one statement, so they always describe the same moment. */
    @GetMapping("/wallet")
    fun wallet(user: AuthenticatedUser): WalletResponse {
        val balances = jdbc.sql("select kind, balance from accounts where owner_id = :owner")
            .param("owner", user.id.value)
            .query { rs, _ -> rs.getString("kind") to rs.getLong("balance") }
            .list()
            .toMap()
        return WalletResponse(
            available = balances["AVAILABLE"] ?: 0,
            reserved = balances["RESERVED"] ?: 0,
        )
    }

    /** Two queries in one snapshot: an item sold in between cannot be missing from both lists or present in both. */
    @GetMapping("/inventory")
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    fun inventory(user: AuthenticatedUser): InventoryResponse {
        val fungible = jdbc.sql(
            """
            select m.market_id, game_id, def_id, d.name, b.available, b.reserved
            from balances b
            join markets m using (market_key)
            join item_definitions d using (game_id, def_id)
            where b.owner_id = :owner and (b.available > 0 or b.reserved > 0)
            order by d.name
            """
        )
            .param("owner", user.id.value)
            .query { rs, _ ->
                FungibleItemView(
                    marketId = rs.getLong("market_id"),
                    gameId = rs.getString("game_id"),
                    defId = rs.getString("def_id"),
                    name = rs.getString("name"),
                    available = rs.getLong("available"),
                    reserved = rs.getLong("reserved"),
                )
            }
            .list()

        val unique = jdbc.sql(
            """
            select a.asset_id, m.market_id, game_id, def_id, d.name, a.state, a.attributes::text as attributes
            from assets a
            join markets m using (market_key)
            join item_definitions d using (game_id, def_id)
            where a.owner_id = :owner and a.state <> 'BURNED'
            order by a.asset_id
            """
        )
            .param("owner", user.id.value)
            .query { rs, _ ->
                UniqueItemView(
                    assetId = rs.getLong("asset_id"),
                    marketId = rs.getLong("market_id"),
                    gameId = rs.getString("game_id"),
                    defId = rs.getString("def_id"),
                    name = rs.getString("name"),
                    state = rs.getString("state"),
                    attributes = rs.getString("attributes"),
                )
            }
            .list()

        return InventoryResponse(fungible, unique)
    }
}
