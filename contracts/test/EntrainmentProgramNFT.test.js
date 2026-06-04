const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EntrainmentProgramNFT", function () {
  let nft, pay, admin, creator, buyer, treasury;
  const PRICE = 1000n;
  const FEE_BPS = 250n; // 2.5% protocol cut
  const ROYALTY_BPS = 500n; // 5% EIP-2981 secondary royalty
  const PROGRAM_HASH =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  const DURATION = 600; // 10 min dose
  const BAND_SET = 7n;
  const DOSE_URI = "ipfs://dose-descriptor";

  beforeEach(async () => {
    [admin, creator, buyer, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    pay = await Mock.deploy("Pay", "PAY");
    const NFT = await ethers.getContractFactory("EntrainmentProgramNFT");
    // permissionless publishing on
    nft = await NFT.deploy(admin.address, treasury.address, FEE_BPS, true);

    await pay.mint(buyer.address, 10000n);
    await pay.connect(buyer).approve(await nft.getAddress(), 10000n);
  });

  async function publishErc20() {
    const tx = await nft
      .connect(creator)
      .publishProgram(
        "Deep Theta Dose",
        PROGRAM_HASH,
        await pay.getAddress(),
        PRICE,
        DURATION,
        BAND_SET,
        DOSE_URI,
        ROYALTY_BPS
      );
    await tx.wait();
    return 0n; // first programId
  }

  it("publishes a program (template, no NFT) and stores on-chain metadata", async () => {
    const programId = await publishErc20();
    expect(await nft.programCount()).to.equal(1n);
    expect(await nft.totalMinted()).to.equal(0n); // publishing mints no edition

    const p = await nft.getProgram(programId);
    expect(p.creator).to.equal(creator.address);
    expect(p.payToken).to.equal(await pay.getAddress());
    expect(p.price).to.equal(PRICE);
    expect(p.programHash).to.equal(PROGRAM_HASH);
    expect(p.durationSecs).to.equal(DURATION);
    expect(p.bandSet).to.equal(BAND_SET);
    expect(p.active).to.equal(true);
    expect(p.name).to.equal("Deep Theta Dose");
    expect(p.doseURI).to.equal(DOSE_URI);
  });

  it("emits programPublished", async () => {
    await expect(
      nft
        .connect(creator)
        .publishProgram(
          "Deep Theta Dose",
          PROGRAM_HASH,
          await pay.getAddress(),
          PRICE,
          DURATION,
          BAND_SET,
          DOSE_URI,
          ROYALTY_BPS
        )
    )
      .to.emit(nft, "ProgramPublished")
      .withArgs(0n, creator.address, PROGRAM_HASH, await pay.getAddress(), PRICE);
  });

  it("mints an edition referencing the template; routes payment to creator minus protocol cut", async () => {
    const programId = await publishErc20();

    await expect(nft.connect(buyer).mintEdition(programId, buyer.address))
      .to.emit(nft, "EditionMinted")
      .withArgs(0n, programId, buyer.address, PRICE, (PRICE * FEE_BPS) / 10000n);

    // edition NFT owned by buyer and points back to its template
    expect(await nft.ownerOf(0)).to.equal(buyer.address);
    expect(await nft.templateOf(0)).to.equal(programId);
    expect(await nft.totalMinted()).to.equal(1n);

    // payment split: creator gets price - cut, treasury gets cut
    const cut = (PRICE * FEE_BPS) / 10000n;
    expect(await pay.balanceOf(treasury.address)).to.equal(cut);
    expect(await pay.balanceOf(creator.address)).to.equal(PRICE - cut);
  });

  it("edition tokenURI returns the template's dose descriptor", async () => {
    const programId = await publishErc20();
    await nft.connect(buyer).mintEdition(programId, buyer.address);
    expect(await nft.tokenURI(0)).to.equal(DOSE_URI);
  });

  it("reports EIP-2981 royalty for an edition correctly", async () => {
    const programId = await publishErc20();
    await nft.connect(buyer).mintEdition(programId, buyer.address);

    const salePrice = 100000n;
    const [receiver, amount] = await nft.royaltyInfo(0, salePrice);
    expect(receiver).to.equal(creator.address);
    expect(amount).to.equal((salePrice * ROYALTY_BPS) / 10000n);

    // supports the EIP-2981 interface id
    expect(await nft.supportsInterface("0x2a55205a")).to.equal(true);
  });

  it("cannot mint an edition of an unpublished (nonexistent) template", async () => {
    await expect(
      nft.connect(buyer).mintEdition(999, buyer.address)
    ).to.be.revertedWithCustomError(nft, "NonexistentProgram");
  });

  it("cannot mint an edition of a deactivated program", async () => {
    const programId = await publishErc20();
    await nft.connect(creator).setProgramActive(programId, false);
    await expect(
      nft.connect(buyer).mintEdition(programId, buyer.address)
    ).to.be.revertedWithCustomError(nft, "ProgramInactive");
  });

  it("requires payment (ERC20 approval) to mint", async () => {
    const programId = await publishErc20();
    await pay.connect(buyer).approve(await nft.getAddress(), 0n);
    await expect(nft.connect(buyer).mintEdition(programId, buyer.address)).to.be
      .reverted;
  });

  it("applies an updated price to subsequent edition mints", async () => {
    const programId = await publishErc20();
    const NEW_PRICE = 2000n;
    await nft.connect(creator).setProgramPrice(programId, NEW_PRICE);

    await nft.connect(buyer).mintEdition(programId, buyer.address);
    const cut = (NEW_PRICE * FEE_BPS) / 10000n;
    expect(await pay.balanceOf(creator.address)).to.equal(NEW_PRICE - cut);
    expect(await pay.balanceOf(treasury.address)).to.equal(cut);
  });

  it("supports native-coin payment, routing value to creator minus cut", async () => {
    // publish a native-priced program (payToken == address(0))
    const NATIVE_PRICE = ethers.parseEther("1");
    await nft
      .connect(creator)
      .publishProgram(
        "Native Dose",
        PROGRAM_HASH,
        "0x0000000000000000000000000000000000000000",
        NATIVE_PRICE,
        DURATION,
        BAND_SET,
        DOSE_URI,
        ROYALTY_BPS
      );

    const creatorBefore = await ethers.provider.getBalance(creator.address);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);

    await nft
      .connect(buyer)
      .mintEdition(0, buyer.address, { value: NATIVE_PRICE });

    const cut = (NATIVE_PRICE * FEE_BPS) / 10000n;
    expect(await ethers.provider.getBalance(creator.address)).to.equal(
      creatorBefore + (NATIVE_PRICE - cut)
    );
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(
      treasuryBefore + cut
    );
  });

  it("rejects wrong native value", async () => {
    const NATIVE_PRICE = ethers.parseEther("1");
    await nft
      .connect(creator)
      .publishProgram(
        "Native Dose",
        PROGRAM_HASH,
        "0x0000000000000000000000000000000000000000",
        NATIVE_PRICE,
        DURATION,
        BAND_SET,
        DOSE_URI,
        ROYALTY_BPS
      );
    await expect(
      nft.connect(buyer).mintEdition(0, buyer.address, { value: 1n })
    ).to.be.revertedWithCustomError(nft, "WrongPayment");
  });

  it("blocks non-creator from publishing when permissionless is off", async () => {
    const NFT = await ethers.getContractFactory("EntrainmentProgramNFT");
    const gated = await NFT.deploy(admin.address, treasury.address, FEE_BPS, false);
    await expect(
      gated
        .connect(creator)
        .publishProgram(
          "Gated",
          PROGRAM_HASH,
          await pay.getAddress(),
          PRICE,
          DURATION,
          BAND_SET,
          DOSE_URI,
          ROYALTY_BPS
        )
    ).to.be.revertedWithCustomError(gated, "PublishNotPermitted");
  });
});
