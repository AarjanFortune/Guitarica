import torch
import torch.nn as nn
import torch.nn.functional as F

from encoder_modules import (
    ASRInterface,
    ConformerEncoder,
    subsequent_mask,
    make_non_pad_mask,
    make_pad_mask,
    mask_by_length,
)
from ignite.utils import convert_tensor
import math
import random


class GuidedAttentionLoss(nn.Module):
    """Guided attention loss function module.
    This module calculates the guided attention loss described
    in `Efficiently Trainable Text-to-Speech System Based
    on Deep Convolutional Networks with Guided Attention`_,
    which forces the attention to be diagonal.
    .. _`Efficiently Trainable Text-to-Speech System
        Based on Deep Convolutional Networks with Guided Attention`:
        https://arxiv.org/abs/1710.08969
    """

    def __init__(self, sigma=0.2, alpha=1.0, reset_always=True):
        """Initialize guided attention loss module.
        Args:
            sigma (float, optional): Standard deviation to control
                how close attention to a diagonal.
            alpha (float, optional): Scaling coefficient (lambda).
            reset_always (bool, optional): Whether to always reset masks.
        """
        super(GuidedAttentionLoss, self).__init__()
        self.sigma = sigma
        self.alpha = alpha
        self.reset_always = reset_always
        self.guided_attn_masks = None
        self.masks = None

    def _reset_masks(self):
        self.guided_attn_masks = None
        self.masks = None

    def forward(self, att_ws, ilens, olens):
        """Calculate forward propagation.
        Args:
            att_ws (Tensor): Batch of attention weights (B, T_max_out, T_max_in).
            ilens (LongTensor): Batch of input lengths (B,).
            olens (LongTensor): Batch of output lengths (B,).
        Returns:
            Tensor: Guided attention loss value.
        """
        if self.guided_attn_masks is None:
            self.guided_attn_masks = self._make_guided_attention_masks(ilens, olens).to(
                att_ws.device
            )
        if self.masks is None:
            self.masks = self._make_masks(ilens, olens).to(att_ws.device)
        losses = self.guided_attn_masks * att_ws
        loss = torch.mean(losses.masked_select(self.masks))
        if self.reset_always:
            self._reset_masks()
        return self.alpha * loss

    def _make_guided_attention_masks(self, ilens, olens):
        n_batches = len(ilens)
        max_ilen = max(ilens)
        max_olen = max(olens)
        guided_attn_masks = torch.zeros((n_batches, max_olen, max_ilen))
        for idx, (ilen, olen) in enumerate(zip(ilens, olens)):
            guided_attn_masks[idx, :olen, :ilen] = self._make_guided_attention_mask(
                ilen, olen, self.sigma
            )
        return guided_attn_masks

    @staticmethod
    def _make_guided_attention_mask(ilen, olen, sigma):
        """Make guided attention mask.
        Examples:
            >>> guided_attn_mask =_make_guided_attention(5, 5, 0.4)
            >>> guided_attn_mask.shape
            torch.Size([5, 5])
            >>> guided_attn_mask
            tensor([[0.0000, 0.1175, 0.3935, 0.6753, 0.8647],
                    [0.1175, 0.0000, 0.1175, 0.3935, 0.6753],
                    [0.3935, 0.1175, 0.0000, 0.1175, 0.3935],
                    [0.6753, 0.3935, 0.1175, 0.0000, 0.1175],
                    [0.8647, 0.6753, 0.3935, 0.1175, 0.0000]])
            >>> guided_attn_mask =_make_guided_attention(3, 6, 0.4)
            >>> guided_attn_mask.shape
            torch.Size([6, 3])
            >>> guided_attn_mask
            tensor([[0.0000, 0.2934, 0.7506],
                    [0.0831, 0.0831, 0.5422],
                    [0.2934, 0.0000, 0.2934],
                    [0.5422, 0.0831, 0.0831],
                    [0.7506, 0.2934, 0.0000],
                    [0.8858, 0.5422, 0.0831]])
        """
        # PyTorch >=1.10 requires an explicit `indexing` argument for
        # torch.meshgrid (previously defaulted to 'ij' with a warning;
        # some newer builds make the unspecified case a hard error).
        # 'ij' is passed explicitly to preserve the original behavior exactly.
        grid_x, grid_y = torch.meshgrid(
            torch.arange(olen), torch.arange(ilen), indexing='ij'
        )
        grid_x, grid_y = grid_x.float().to(olen.device), grid_y.float().to(ilen.device)
        return 1.0 - torch.exp(
            -((grid_y / ilen - grid_x / olen) ** 2) / (2 * (sigma ** 2))
        )

    @staticmethod
    def _make_masks(ilens, olens):
        """Make masks indicating non-padded part.
        Args:
            ilens (LongTensor or List): Batch of lengths (B,).
            olens (LongTensor or List): Batch of lengths (B,).
        Returns:
            Tensor: Mask tensor indicating non-padded part.
                    dtype=torch.uint8 in PyTorch 1.2-
                    dtype=torch.bool in PyTorch 1.2+ (including 1.2)
        Examples:
            >>> ilens, olens = [5, 2], [8, 5]
            >>> _make_mask(ilens, olens)
            tensor([[[1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1],
                     [1, 1, 1, 1, 1]],
                    [[1, 1, 0, 0, 0],
                     [1, 1, 0, 0, 0],
                     [1, 1, 0, 0, 0],
                     [1, 1, 0, 0, 0],
                     [1, 1, 0, 0, 0],
                     [0, 0, 0, 0, 0],
                     [0, 0, 0, 0, 0],
                     [0, 0, 0, 0, 0]]], dtype=torch.uint8)
        """
        in_masks = make_non_pad_mask(ilens)  # (B, T_in)
        out_masks = make_non_pad_mask(olens)  # (B, T_out)
        # (B, T_out, T_in)
        return out_masks.unsqueeze(-1) & in_masks.unsqueeze(-2)

    # (batch, time, 6, 21)


class InhibitionLoss(nn.Module):
    """Pairwise inhibition loss for the *Logistic* output-layer formulation.

    Implements Sec. 2.3-2.4 of Cwitkowitz et al., "A Data-Driven Methodology
    for Considering Feasibility and Pairwise Likelihood in Deep Learning
    Based Guitar Tablature Transcription Systems" (ISMIR/arXiv:2204.08094).

    Each string/fret (S/F) combination c is assigned an inhibition weight
    w(c_i, c_j) in [0, 1] against every other combination, derived from the
    complement of the pairwise co-occurrence likelihood (IoU) estimated from
    a large collection of symbolic tablature (Eq. 6-7):

        w(ci, cj) = (1 - IoU(i, j)) ** boost

    During training, the loss penalizes the model for producing high,
    simultaneous activations for pairs of S/F combinations that rarely or
    never co-occur in real playing (Eq. 8):

        L_inh = 1/(2N) * sum_n sum_i sum_j  z_i,n * z_j,n * w(ci, cj)

    An inhibition weight matrix is always required; it is expected to be
    estimated offline from a symbolic tablature collection (Eq. 4-6) and
    passed in via `inhibition_matrix`, or built from a raw IoU matrix with
    `from_pairwise_likelihood()`.
    """

    def __init__(self, inhibition_matrix, num_strings=6, num_frets=21):
        super(InhibitionLoss, self).__init__()
        self.num_strings = num_strings
        self.num_frets = num_frets
        self.num_combinations = num_strings * num_frets

        if inhibition_matrix is None:
            raise ValueError(
                "inhibition_matrix is required -- pass in a pairwise "
                "likelihood/inhibition weight matrix estimated from "
                "symbolic tablature (see estimate_pairwise_likelihood.py).")

        inhibition_matrix = torch.as_tensor(inhibition_matrix, dtype=torch.float32)

        assert inhibition_matrix.shape == (self.num_combinations, self.num_combinations), \
            f"expected a ({self.num_combinations}, {self.num_combinations}) inhibition matrix, " \
            f"got {tuple(inhibition_matrix.shape)}"

        # register as buffer so it moves with .to(device)/.cuda() but is
        # not treated as a learnable parameter
        self.register_buffer("inhibition_matrix", inhibition_matrix)

    @classmethod
    def from_pairwise_likelihood(cls, iou_matrix, num_strings=6, num_frets=21, boost=1):
        """Build inhibition weights directly from an estimated pairwise
        co-occurrence likelihood (IoU) matrix, per Eq. (7). `iou_matrix`
        is typically produced offline via `estimate_pairwise_likelihood.py`
        over a large symbolic tablature collection (e.g. DadaGP)."""
        iou_matrix = torch.as_tensor(iou_matrix, dtype=torch.float32)
        weights = (iou_matrix).clamp(0.0, 1.0) ** boost #this was error no need to 1-iou alreadhy inhibition matraix we getting
        return cls(inhibition_matrix=weights, num_strings=num_strings, num_frets=num_frets)

    def forward(self, activations, olens=None):
        """
        Args:
            activations: (batch, time, num_strings, num_frets) tensor of
                *sigmoid* activations from the Logistic output layer
                (pre-thresholding, post-sigmoid).
            olens: optional (batch,) tensor/list of valid (non-padded)
                frame counts per batch item, used to mask out padding
                exactly as `frame_loss` does elsewhere in this module.
        Returns:
            Scalar inhibition loss (Eq. 8).
        """
        batch_size, time_steps = activations.shape[0], activations.shape[1]
        z = activations.reshape(batch_size, time_steps, self.num_combinations)

        # outer product of activations for every pair of S/F combinations
        # at every frame -> (batch, time, C, C)
        pairwise_products = z.unsqueeze(-1) * z.unsqueeze(-2)
        weighted = pairwise_products * self.inhibition_matrix

        # sum over the C x C combination pairs at each frame; the factor of
        # two in Eq. (8) removes the redundancy of summing both (i, j) and
        # (j, i) permutations of each pair
        per_frame_loss = weighted.sum(dim=(-2, -1)) / 2.0

        if olens is not None:
            mask = make_non_pad_mask(olens).to(per_frame_loss.device)
            per_frame_loss = per_frame_loss * mask.float()
            denom = mask.float().sum().clamp(min=1.0)
        else:
            denom = float(batch_size * time_steps)

        return per_frame_loss.sum() / denom


class CustomLoss(nn.Module):
    def __init__(self, mode, use_galoss, use_onset_loss=True, onset_loss_weight=1.0,
                 inhibition_loss=None, inhibition_lambda=0.0):
        """
        Args:
            mode: "tab".
            use_galoss: whether to include the guided-attention loss term.
            use_onset_loss: whether to include the note-onset loss term.
            onset_loss_weight: scaling for the onset loss term.
            inhibition_loss: an `InhibitionLoss` module. Only used when
                inhibition_lambda > 0.
            inhibition_lambda: scaling term lambda for the inhibition loss
                in the combined objective L_total = L_BCE + lambda * L_inh
                (Eq. 9). Set to 0 to disable.
        """
        super(CustomLoss, self).__init__()
        weight = torch.ones(21) * 500
        weight[20] = 1
        self.register_buffer("weight", weight)  # so it moves with .to(device)/.cuda()

        # Binary cross-entropy formula (Eq. 3 of the paper), applied to
        # independent per-S/F sigmoid outputs (Logistic formulation), which
        # is what allows the inhibition term to be added without conflicting
        # with a normalization constraint (Sec. 2.2).
        self.cross_entropy = lambda gt, pred: -gt * \
            torch.log(pred + 1e-7) - (1 - gt) * torch.log(1 - pred + 1e-7)

        self.GALoss = GuidedAttentionLoss(sigma=0.4, alpha=1)
        self.mode = mode
        self.use_galoss = use_galoss
        self.use_onset_loss = use_onset_loss
        self.onset_loss_weight = onset_loss_weight

        self.inhibition_loss = inhibition_loss
        self.inhibition_lambda = inhibition_lambda
        if self.inhibition_lambda > 0:
            assert self.inhibition_loss is not None, \
                "inhibition_loss module must be provided when inhibition_lambda > 0"

    def forward(self, frame_pred, frame_gt, note_pred, note_gt, attn, olens, note_len,
                note_onset_pred=None, note_onset_gt=None):
        batch_size = frame_gt.shape[0]
        attn_loss = 0

        frame_loss = self.cross_entropy(frame_gt, frame_pred)
        frame_loss = mask_by_length(frame_loss, olens)
        note_loss = self.cross_entropy(note_gt, note_pred)

        frame_loss = torch.sum(frame_loss) / torch.sum(olens) / 126

        note_loss = torch.mean(note_loss)

        for head in range(attn.shape[1]):
            attn_loss += self.GALoss(attn[:, head], olens, olens)

        # --- note-level onset loss only ---
        onset_loss = 0
        if self.use_onset_loss and note_onset_pred is not None:
            note_onset_loss = self.cross_entropy(note_onset_gt, note_onset_pred)
            note_onset_loss = torch.mean(note_onset_loss)
            onset_loss = note_onset_loss

        # --- pairwise inhibition loss (Logistic formulation) ---
        # Eq. (9): L_total = L_BCE + lambda * L_inh
        inhib_loss = 0
        if self.inhibition_lambda > 0 and self.inhibition_loss is not None:
            inhib_loss = self.inhibition_loss(frame_pred, olens=olens)

        if self.use_galoss:
            loss = frame_loss + note_loss + attn_loss + self.onset_loss_weight * onset_loss
        else:
            loss = frame_loss + note_loss + self.onset_loss_weight * onset_loss

        loss = loss + self.inhibition_lambda * inhib_loss

        return loss


class ConvStack(nn.Module):
    def __init__(self, input_features, output_features, input_ch):
        super(ConvStack, self).__init__()

        self.cnn = nn.Sequential(
            # layer 0
            nn.Conv2d(input_ch, output_features // 16, (3, 3), padding=1),
            nn.BatchNorm2d(output_features // 16),
            nn.ReLU(),
            # layer 1
            nn.Conv2d(output_features // 16, output_features //
                      16, (3, 3), padding=1),
            nn.BatchNorm2d(output_features // 16),
            nn.ReLU(),
            # layer 2
            nn.MaxPool2d((1, 2)),
            nn.Dropout(0.25),
            nn.Conv2d(output_features // 16,
                      output_features // 8, (3, 3), padding=1),
            nn.BatchNorm2d(output_features // 8),
            nn.ReLU(),
            # layer 3
            nn.MaxPool2d((1, 2)),
            nn.Dropout(0.25),
        )
        self.fc = nn.Sequential(
            nn.Linear((output_features // 8) *
                      (input_features // 4), output_features),
            nn.Dropout(0.5)
        )

    def forward(self, X):
        y = self.cnn(X)
        y = y.transpose(1, 2).flatten(-2)
        y = self.fc(y)
        return y


class BiLSTMGRUBlock(nn.Module):
    """Hybrid BiLSTM -> GRU refinement block.

    Meant to sit between the encoder output and a prediction head:
        encoder_output -> BiLSTMGRUBlock -> output_layer -> activation

    The BiLSTM first captures long-range bidirectional context, its output
    is then further refined by a (bidirectional) GRU, projected back down
    to `input_size` so it's a drop-in replacement for the raw encoder
    features, and combined with a residual connection + LayerNorm so the
    block can be inserted without destabilizing an already-trained-ish
    pipeline (it can learn to be close to identity early in training).
    """

    def __init__(self, input_size, hidden_size=None, dropout=0.25, bidirectional=True):
        super(BiLSTMGRUBlock, self).__init__()
        hidden_size = hidden_size or input_size
        num_directions = 2 if bidirectional else 1

        self.bilstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=1,
            batch_first=True,
            bidirectional=bidirectional,
        )
        self.gru = nn.GRU(
            input_size=hidden_size * num_directions,
            hidden_size=hidden_size,
            num_layers=1,
            batch_first=True,
            bidirectional=bidirectional,
        )
        self.proj = nn.Linear(hidden_size * num_directions, input_size)
        self.dropout = nn.Dropout(dropout)
        self.layer_norm = nn.LayerNorm(input_size)

    def forward(self, x):
        # x: (batch, time, input_size)
        residual = x
        out, _ = self.bilstm(x)
        out, _ = self.gru(out)
        out = self.proj(out)
        out = self.dropout(out)
        out = self.layer_norm(out + residual)
        return out


class TabEstimator(ASRInterface, torch.nn.Module):
    def __init__(self, mode, use_custom_decimation_func, use_conv_stack, n_bins, hop_length, sr,
                 encoder_heads=1, encoder_layers=1, normalize_before=True):
        """
        Uses the Conformer encoder and the Logistic output formulation
        (Eq. 3 of the paper): each of the 6 x 21 string/fret combinations
        gets an independent sigmoid activation, enabling the pairwise
        inhibition loss (Eq. 8) to be used during training. Inference
        still selects one fret per string via argmax (Eq. 2), unaffected
        by the choice of activation.
        """
        super(TabEstimator, self).__init__()
        self.mode = mode
        self.use_custom_decimation_func = use_custom_decimation_func
        self.use_conv_stack = use_conv_stack
        self.hop_length = hop_length
        self.sr = sr
        self.encoder_output_size = 64
        self.n_encoder_ffn = 64
        self.encoder_attn_dropout = 0
        self.encoder_pos_dropout = 0.1
        self.conv_output_features = 16 * 32

        if use_conv_stack:
            self.convstack = ConvStack(n_bins, self.conv_output_features, 1)

        self.encoder = ConformerEncoder(self.conv_output_features if use_conv_stack else n_bins,
                                        output_size=self.encoder_output_size,
                                        attention_heads=encoder_heads,
                                        linear_units=self.n_encoder_ffn,
                                        num_blocks=encoder_layers,
                                        attention_dropout_rate=self.encoder_attn_dropout,
                                        input_layer='linear',
                                        positionwise_layer_type='conv1d',
                                        positionwise_conv_kernel_size=3,
                                        normalize_before=normalize_before,
                                        macaron_style=False,
                                        rel_pos_type="latest",
                                        pos_enc_layer_type="rel_pos",
                                        selfattention_layer_type="rel_selfattn",
                                        cnn_module_kernel=3)

        # Hybrid BiLSTM-GRU refinement blocks, one per output head, applied
        # right before that head's linear output layer (see forward()).
        self.frame_tab_bilstm_gru = BiLSTMGRUBlock(self.encoder_output_size)
        self.note_tab_bilstm_gru = BiLSTMGRUBlock(self.encoder_output_size)
        self.note_tab_onset_bilstm_gru = BiLSTMGRUBlock(self.encoder_output_size)

        self.frame_tab_output_layer = nn.Sequential(
            nn.Dropout(0.25),
            nn.Linear(self.encoder_output_size, 128),
            nn.ReLU(),
            nn.Dropout(0.5),
            nn.Linear(128, 126)
        )

        self.note_tab_output_layer = nn.Sequential(
            nn.Dropout(0.25),
            nn.Linear(self.encoder_output_size, 128),
            nn.ReLU(),
            nn.Dropout(0.5),
            nn.Linear(128, 126)
        )
        self.note_tab_onset_output_layer = nn.Sequential(
            nn.Dropout(0.25),
            nn.Linear(self.encoder_output_size, 128),
            nn.ReLU(),
            nn.Dropout(0.5),
            nn.Linear(128, 126)
        )
        # Logistic formulation (Eq. 3): an independent sigmoid per
        # string/fret combination, which allows the pairwise
        # inhibition loss to shape co-activations across strings.
        self.tab_output_activation = nn.Sigmoid()

        self.note_encoder = ConformerEncoder(self.encoder_output_size,
                                             output_size=self.encoder_output_size,
                                             attention_heads=encoder_heads,
                                             linear_units=self.n_encoder_ffn,
                                             num_blocks=encoder_layers,
                                             attention_dropout_rate=self.encoder_attn_dropout,
                                             input_layer='linear',
                                             positionwise_layer_type='conv1d',
                                             positionwise_conv_kernel_size=3,
                                             normalize_before=normalize_before,
                                             macaron_style=False,
                                             rel_pos_type="latest",
                                             pos_enc_layer_type="rel_pos",
                                             selfattention_layer_type="rel_selfattn",
                                             cnn_module_kernel=3)

    def forward(self, src_pad, src_len, note_len, bpm):
        batch_size = src_pad.shape[0]

        if self.use_conv_stack:
            encoder_in = self.convstack(torch.unsqueeze(src_pad, dim=1))
        else:
            encoder_in = src_pad

        # Transformer or Conformer encoder
        memory, olens, _ = self.encoder(encoder_in, src_len)

        if self.use_custom_decimation_func:
            # custom decimation function
            with torch.no_grad():
                decimated_memory = self.notelevel_decimation(memory, bpm)
        else:
            # decimation using F.interpolate
            with torch.no_grad():
                # (batch, features, length)
                memory_cpy = torch.swapaxes(memory, 1, 2)
                decimated_memory = torch.zeros(
                    batch_size, self.encoder_output_size, 64).to(memory.device)
                for n_batch in range(batch_size):
                    decimated_memory[n_batch] = torch.squeeze(F.interpolate(
                        torch.unsqueeze(memory_cpy[n_batch, :, :olens[n_batch]], 0), size=64), 0)
                decimated_memory = torch.swapaxes(decimated_memory, 1, 2)

        if self.mode == "tab":
            # frame-level tab output layer
            frame_tab_hidden = self.frame_tab_bilstm_gru(memory)
            frame_tab_pred = self.frame_tab_output_layer(frame_tab_hidden)
            frame_tab_pred = frame_tab_pred.view(batch_size, -1, 6, 21)
            frame_tab_pred = self.tab_output_activation(frame_tab_pred)

            # note-level tab output layer
            decimated_memory, _, _ = self.note_encoder(
                decimated_memory, note_len)

            note_tab_hidden = self.note_tab_bilstm_gru(decimated_memory)
            note_tab_pred = self.note_tab_output_layer(note_tab_hidden)
            note_tab_pred = note_tab_pred.view(batch_size, -1, 6, 21)
            note_tab_pred = self.tab_output_activation(note_tab_pred)

            note_tab_onset_hidden = self.note_tab_onset_bilstm_gru(decimated_memory)
            note_tab_onset_pred = self.note_tab_onset_output_layer(note_tab_onset_hidden)
            note_tab_onset_pred = note_tab_onset_pred.view(batch_size, -1, 6, 21)
            note_tab_onset_pred = self.tab_output_activation(note_tab_onset_pred)


            return frame_tab_pred, note_tab_pred, note_tab_onset_pred, olens

        else:
            print("mode must be 'tab'")

    def notelevel_decimation(self, memory, bpm):
        # memory(batch, len, features)
        padded_memory = F.pad(memory, (0, 0, 0, 10))  # for margin of error
        batch_size = memory.shape[0]
        feature_size = self.encoder_output_size
        output = torch.zeros(batch_size, 64, feature_size).to(memory.device)

        for n_batch in range(batch_size):
            frames_per_note = (
                (self.sr * 60) / (self.hop_length * 4 * bpm[n_batch])).float()
            for n_note in range(64):
                frame_start = n_note * frames_per_note
                start_floor = torch.floor(frame_start).int()
                start_ceil = torch.ceil(frame_start).int()
                frame_end = (n_note + 1) * frames_per_note
                end_floor = torch.floor(frame_end).int()
                end_ceil = torch.ceil(frame_end).int()

                sum_prob = padded_memory[n_batch,
                                         start_floor, :] * (start_ceil - frame_start)
                sum_prob = torch.add(sum_prob, torch.sum(
                    padded_memory[n_batch, start_ceil:end_floor, :], dim=0))
                sum_prob = torch.add(
                    sum_prob, padded_memory[n_batch, end_floor, :] * (frame_end - end_floor))
                mean_prob = sum_prob / frames_per_note
                output[n_batch, n_note] = mean_prob

        return output