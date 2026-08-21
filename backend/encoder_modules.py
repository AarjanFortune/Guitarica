

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


# --------------------------------------------------------------------------
# ASRInterface stand-in
# --------------------------------------------------------------------------
class ASRInterface:
    """Minimal stand-in for espnet.nets.asr_interface.ASRInterface.
    """
    pass


# --------------------------------------------------------------------------
# Masking utilities (espnet.nets.pytorch_backend.nets_utils / transformer.mask)
# --------------------------------------------------------------------------
def make_pad_mask(lengths, xs=None, length_dim=-1, maxlen=None):
    """True where the position is padding.

    Args:
        lengths (LongTensor or list[int]): (B,)
    Returns:
        BoolTensor: (B, maxlen) — True = pad position.
    """
    if not isinstance(lengths, torch.Tensor):
        lengths = torch.tensor(lengths)
    bs = int(lengths.size(0))
    if maxlen is None:
        maxlen = int(xs.size(length_dim)) if xs is not None else int(lengths.max())

    seq_range = torch.arange(0, maxlen, dtype=torch.int64, device=lengths.device)
    seq_range_expand = seq_range.unsqueeze(0).expand(bs, maxlen)
    seq_length_expand = lengths.unsqueeze(-1)
    mask = seq_range_expand >= seq_length_expand
    return mask


def make_non_pad_mask(lengths, xs=None, length_dim=-1):
    """True where the position is real (non-pad) data. Inverse of make_pad_mask."""
    return ~make_pad_mask(lengths, xs, length_dim)


def mask_by_length(xs, lengths, fill=0):
    """Zero out (or fill) positions beyond each sequence's length.

    Args:
        xs (Tensor): (B, T, ...)
        lengths (LongTensor or list[int]): (B,)
    """
    assert xs.size(0) == len(lengths)
    ret = xs.data.new(*xs.size()).fill_(fill)
    for i, l in enumerate(lengths):
        ret[i, :l] = xs[i, :l]
    return ret


def subsequent_mask(size, device="cpu", dtype=torch.bool):
    """Lower-triangular causal mask, kept for parity with the original import
    (unused elsewhere in tab_estimator_model.py)."""
    ret = torch.ones(size, size, device=device, dtype=dtype)
    return torch.tril(ret, out=ret)


# --------------------------------------------------------------------------
# Positional encodings
# --------------------------------------------------------------------------
class RelPositionalEncoding(nn.Module):
    """Relative positional encoding used by the Conformer's rel-pos attention
    (Transformer-XL style, as used in ESPnet's conformer implementation)."""

    def __init__(self, d_model, dropout_rate, max_len=5000):
        super().__init__()
        self.d_model = d_model
        self.xscale = math.sqrt(self.d_model)
        self.dropout = nn.Dropout(p=dropout_rate)
        self.pe = None
        self._extend_pe(torch.tensor(0.0).expand(1, max_len))

    def _extend_pe(self, x):
        if self.pe is not None and self.pe.size(1) >= x.size(1) * 2 - 1:
            if self.pe.dtype != x.dtype or self.pe.device != x.device:
                self.pe = self.pe.to(dtype=x.dtype, device=x.device)
            return
        pe_positive = torch.zeros(x.size(1), self.d_model)
        pe_negative = torch.zeros(x.size(1), self.d_model)
        position = torch.arange(0, x.size(1), dtype=torch.float32).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, self.d_model, 2, dtype=torch.float32)
            * -(math.log(10000.0) / self.d_model)
        )
        pe_positive[:, 0::2] = torch.sin(position * div_term)
        pe_positive[:, 1::2] = torch.cos(position * div_term)
        pe_negative[:, 0::2] = torch.sin(-1 * position * div_term)
        pe_negative[:, 1::2] = torch.cos(-1 * position * div_term)
        pe_positive = torch.flip(pe_positive, [0]).unsqueeze(0)
        pe_negative = pe_negative[1:].unsqueeze(0)
        pe = torch.cat([pe_positive, pe_negative], dim=1)
        self.pe = pe.to(device=x.device, dtype=x.dtype)

    def forward(self, x):
        """Returns (scaled_x, pos_emb) — pos_emb is consumed by
        RelPositionMultiHeadedAttention."""
        self._extend_pe(x)
        x = x * self.xscale
        pos_emb = self.pe[
            :, self.pe.size(1) // 2 - x.size(1) + 1: self.pe.size(1) // 2 + x.size(1)
        ]
        return self.dropout(x), self.dropout(pos_emb)


# --------------------------------------------------------------------------
# Attention
# --------------------------------------------------------------------------
class MultiHeadedAttention(nn.Module):
    def __init__(self, n_head, n_feat, dropout_rate):
        super().__init__()
        assert n_feat % n_head == 0
        self.d_k = n_feat // n_head
        self.h = n_head
        self.linear_q = nn.Linear(n_feat, n_feat)
        self.linear_k = nn.Linear(n_feat, n_feat)
        self.linear_v = nn.Linear(n_feat, n_feat)
        self.linear_out = nn.Linear(n_feat, n_feat)
        self.attn = None
        self.dropout = nn.Dropout(p=dropout_rate)

    def forward_qkv(self, query, key, value):
        n_batch = query.size(0)
        q = self.linear_q(query).view(n_batch, -1, self.h, self.d_k)
        k = self.linear_k(key).view(n_batch, -1, self.h, self.d_k)
        v = self.linear_v(value).view(n_batch, -1, self.h, self.d_k)
        return q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)

    def forward_attention(self, value, scores, mask):
        n_batch = value.size(0)
        if mask is not None:
            mask = mask.unsqueeze(1).eq(0)
            min_value = torch.finfo(scores.dtype).min
            scores = scores.masked_fill(mask, min_value)
            self.attn = torch.softmax(scores, dim=-1).masked_fill(mask, 0.0)
        else:
            self.attn = torch.softmax(scores, dim=-1)
        p_attn = self.dropout(self.attn)
        x = torch.matmul(p_attn, value)
        x = x.transpose(1, 2).contiguous().view(n_batch, -1, self.h * self.d_k)
        return self.linear_out(x)

    def forward(self, query, key, value, mask):
        q, k, v = self.forward_qkv(query, key, value)
        scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(self.d_k)
        return self.forward_attention(v, scores, mask)


class RelPositionMultiHeadedAttention(MultiHeadedAttention):
    """Multi-head attention with Transformer-XL-style relative positional
    encoding, as used by the Conformer encoder ("rel_selfattn")."""

    def __init__(self, n_head, n_feat, dropout_rate, zero_triu=False):
        super().__init__(n_head, n_feat, dropout_rate)
        self.zero_triu = zero_triu
        self.linear_pos = nn.Linear(n_feat, n_feat, bias=False)
        self.pos_bias_u = nn.Parameter(torch.Tensor(self.h, self.d_k))
        self.pos_bias_v = nn.Parameter(torch.Tensor(self.h, self.d_k))
        nn.init.xavier_uniform_(self.pos_bias_u)
        nn.init.xavier_uniform_(self.pos_bias_v)

    def rel_shift(self, x):
        zero_pad = torch.zeros((*x.size()[:3], 1), device=x.device, dtype=x.dtype)
        x_padded = torch.cat([zero_pad, x], dim=-1)
        x_padded = x_padded.view(*x.size()[:2], x.size(3) + 1, x.size(2))
        x = x_padded[:, :, 1:].view_as(x)[:, :, :, : x.size(-1) // 2 + 1]
        if self.zero_triu:
            ones = torch.ones((x.size(2), x.size(3)), device=x.device)
            x = x * torch.tril(ones, x.size(3) - x.size(2))[None, None, :, :]
        return x

    def forward(self, query, key, value, pos_emb, mask):
        q, k, v = self.forward_qkv(query, key, value)
        q = q.transpose(1, 2)  # (batch, time1, head, d_k)

        n_batch_pos = pos_emb.size(0)
        p = self.linear_pos(pos_emb).view(n_batch_pos, -1, self.h, self.d_k)
        p = p.transpose(1, 2)  # (batch, head, 2*time1-1, d_k)

        q_with_bias_u = (q + self.pos_bias_u).transpose(1, 2)
        q_with_bias_v = (q + self.pos_bias_v).transpose(1, 2)

        matrix_ac = torch.matmul(q_with_bias_u, k.transpose(-2, -1))
        matrix_bd = torch.matmul(q_with_bias_v, p.transpose(-2, -1))
        matrix_bd = self.rel_shift(matrix_bd)

        scores = (matrix_ac + matrix_bd) / math.sqrt(self.d_k)
        return self.forward_attention(v, scores, mask)


# --------------------------------------------------------------------------
# Position-wise feed-forward
# --------------------------------------------------------------------------
class PositionwiseFeedForward(nn.Module):
    def __init__(self, idim, hidden_units, dropout_rate, activation=None):
        super().__init__()
        self.w_1 = nn.Linear(idim, hidden_units)
        self.w_2 = nn.Linear(hidden_units, idim)
        self.dropout = nn.Dropout(dropout_rate)
        self.activation = activation if activation is not None else nn.ReLU()

    def forward(self, x):
        return self.w_2(self.dropout(self.activation(self.w_1(x))))


class Conv1dLinear(nn.Module):
    """Conv1d -> ReLU -> Linear feed-forward variant
    ("positionwise_layer_type='conv1d'")."""

    def __init__(self, idim, hidden_units, kernel_size, dropout_rate):
        super().__init__()
        self.w_1 = nn.Conv1d(
            idim, hidden_units, kernel_size, stride=1, padding=(kernel_size - 1) // 2
        )
        self.w_2 = nn.Linear(hidden_units, idim)
        self.dropout = nn.Dropout(dropout_rate)

    def forward(self, x):
        x = torch.relu(self.w_1(x.transpose(-1, 1))).transpose(-1, 1)
        return self.w_2(self.dropout(x))


# --------------------------------------------------------------------------
# Conformer convolution module
# --------------------------------------------------------------------------
class ConvolutionModule(nn.Module):
    def __init__(self, channels, kernel_size, activation=None, bias=True):
        super().__init__()
        assert (kernel_size - 1) % 2 == 0
        self.pointwise_conv1 = nn.Conv1d(
            channels, 2 * channels, kernel_size=1, stride=1, padding=0, bias=bias
        )
        self.depthwise_conv = nn.Conv1d(
            channels,
            channels,
            kernel_size,
            stride=1,
            padding=(kernel_size - 1) // 2,
            groups=channels,
            bias=bias,
        )
        self.norm = nn.BatchNorm1d(channels)
        self.pointwise_conv2 = nn.Conv1d(
            channels, channels, kernel_size=1, stride=1, padding=0, bias=bias
        )
        self.activation = activation if activation is not None else nn.SiLU()

    def forward(self, x):
        x = x.transpose(1, 2)  # (batch, channels, time)
        x = self.pointwise_conv1(x)
        x = F.glu(x, dim=1)
        x = self.depthwise_conv(x)
        x = self.activation(self.norm(x))
        x = self.pointwise_conv2(x)
        return x.transpose(1, 2)


# --------------------------------------------------------------------------
# Encoder layers
# --------------------------------------------------------------------------
class ConformerEncoderLayer(nn.Module):
    def __init__(self, size, self_attn, feed_forward, feed_forward_macaron,
                 conv_module, dropout_rate, normalize_before=True, concat_after=False):
        super().__init__()
        self.self_attn = self_attn
        self.feed_forward = feed_forward
        self.feed_forward_macaron = feed_forward_macaron
        self.conv_module = conv_module
        self.norm_ff = nn.LayerNorm(size)
        self.norm_mha = nn.LayerNorm(size)
        if feed_forward_macaron is not None:
            self.norm_ff_macaron = nn.LayerNorm(size)
            self.ff_scale = 0.5
        else:
            self.ff_scale = 1.0
        if conv_module is not None:
            self.norm_conv = nn.LayerNorm(size)
            self.norm_final = nn.LayerNorm(size)
        self.dropout = nn.Dropout(dropout_rate)
        self.normalize_before = normalize_before
        self.concat_after = concat_after
        if concat_after:
            self.concat_linear = nn.Linear(size + size, size)

    def forward(self, x_input, mask):
        if isinstance(x_input, tuple):
            x, pos_emb = x_input
        else:
            x, pos_emb = x_input, None

        if self.feed_forward_macaron is not None:
            residual = x
            if self.normalize_before:
                x = self.norm_ff_macaron(x)
            x = residual + self.ff_scale * self.dropout(self.feed_forward_macaron(x))
            if not self.normalize_before:
                x = self.norm_ff_macaron(x)

        residual = x
        if self.normalize_before:
            x = self.norm_mha(x)
        x_att = (
            self.self_attn(x, x, x, pos_emb, mask)
            if pos_emb is not None
            else self.self_attn(x, x, x, mask)
        )
        if self.concat_after:
            x_concat = torch.cat((x, x_att), dim=-1)
            x = residual + self.concat_linear(x_concat)
        else:
            x = residual + self.dropout(x_att)
        if not self.normalize_before:
            x = self.norm_mha(x)

        if self.conv_module is not None:
            residual = x
            if self.normalize_before:
                x = self.norm_conv(x)
            x = residual + self.dropout(self.conv_module(x))
            if not self.normalize_before:
                x = self.norm_conv(x)

        residual = x
        if self.normalize_before:
            x = self.norm_ff(x)
        x = residual + self.ff_scale * self.dropout(self.feed_forward(x))
        if not self.normalize_before:
            x = self.norm_ff(x)

        if self.conv_module is not None:
            x = self.norm_final(x)

        if pos_emb is not None:
            return (x, pos_emb), mask
        return x, mask


# --------------------------------------------------------------------------
# Encoders (drop-in replacements for espnet2.asr.encoder.*)
# --------------------------------------------------------------------------
class ConformerEncoder(nn.Module):
    """Drop-in replacement for espnet2.asr.encoder.conformer_encoder.ConformerEncoder."""

    def __init__(self, input_size, output_size=256, attention_heads=4,
                 linear_units=2048, num_blocks=6, dropout_rate=0.1,
                 positional_dropout_rate=0.1, attention_dropout_rate=0.0,
                 input_layer="linear", normalize_before=True, concat_after=False,
                 positionwise_layer_type="linear", positionwise_conv_kernel_size=3,
                 macaron_style=False, rel_pos_type="latest",
                 pos_enc_layer_type="rel_pos", selfattention_layer_type="rel_selfattn",
                 use_cnn_module=True, cnn_module_kernel=31, zero_triu=False):
        super().__init__()
        self._output_size = output_size
        self.normalize_before = normalize_before

        if rel_pos_type not in ("legacy", "latest"):
            raise ValueError(f"unknown rel_pos_type: {rel_pos_type}")
        if pos_enc_layer_type != "rel_pos":
            raise NotImplementedError(
                "Only pos_enc_layer_type='rel_pos' is implemented in this "
                "from-scratch encoder."
            )
        if selfattention_layer_type != "rel_selfattn":
            raise NotImplementedError(
                "Only selfattention_layer_type='rel_selfattn' is implemented "
                "in this from-scratch encoder."
            )

        activation = nn.SiLU()  # swish, as used by the original conformer paper/espnet

        if input_layer == "linear":
            self.embed = nn.Sequential(
                nn.Linear(input_size, output_size),
                nn.LayerNorm(output_size),
                nn.Dropout(dropout_rate),
                nn.ReLU(),
            )
        elif input_layer is None:
            self.embed = None
        else:
            raise ValueError(f"unknown input_layer: {input_layer}")

        self.pos_enc = RelPositionalEncoding(output_size, positional_dropout_rate)

        if positionwise_layer_type == "linear":
            positionwise_layer = PositionwiseFeedForward
            positionwise_layer_args = (output_size, linear_units, dropout_rate, activation)
        elif positionwise_layer_type == "conv1d":
            positionwise_layer = Conv1dLinear
            positionwise_layer_args = (
                output_size, linear_units, positionwise_conv_kernel_size, dropout_rate
            )
        else:
            raise NotImplementedError("Support only 'linear' or 'conv1d'.")

        convolution_layer_args = (output_size, cnn_module_kernel, activation)

        self.encoders = nn.ModuleList([
            ConformerEncoderLayer(
                output_size,
                RelPositionMultiHeadedAttention(
                    attention_heads, output_size, attention_dropout_rate, zero_triu
                ),
                positionwise_layer(*positionwise_layer_args),
                positionwise_layer(*positionwise_layer_args) if macaron_style else None,
                ConvolutionModule(*convolution_layer_args) if use_cnn_module else None,
                dropout_rate,
                normalize_before,
                concat_after,
            )
            for _ in range(num_blocks)
        ])
        if self.normalize_before:
            self.after_norm = nn.LayerNorm(output_size)

    def output_size(self):
        return self._output_size

    def forward(self, xs_pad, ilens):
        masks = (~make_pad_mask(ilens)[:, None, :]).to(xs_pad.device)
        if self.embed is not None:
            xs_pad = self.embed(xs_pad)
        xs_pad, pos_emb = self.pos_enc(xs_pad)
        for layer in self.encoders:
            (xs_pad, pos_emb), masks = layer((xs_pad, pos_emb), masks)
        if self.normalize_before:
            xs_pad = self.after_norm(xs_pad)
        olens = masks.squeeze(1).sum(1)
        return xs_pad, olens, None